#!/usr/bin/env node
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface HookInput {
    session_id: string;
    transcript_path: string;
    cwd: string;
    permission_mode: string;
    tool_name: string;
    tool_input: {
        file_path?: string;
        content?: string;
        new_string?: string;
    };
}

interface FilePathPattern {
    pathPatterns?: string[];
    pathExclusions?: string[];
    contentPatterns?: string[];
}

interface SkillRule {
    type: 'guardrail' | 'domain';
    enforcement: 'block' | 'suggest' | 'warn';
    priority: string;
    blockMessage?: string;
    skipConditions?: {
        sessionSkillUsed?: boolean;
        fileMarkers?: string[];
        envOverride?: string;
    };
    fileTriggers?: FilePathPattern;
}

interface SkillRules {
    version: string;
    skills: Record<string, SkillRule>;
}

function matchesGlobPattern(filePath: string, pattern: string): boolean {
    // Convert glob pattern to regex
    // Handle **/* to match zero or more directory levels
    // website/src/**/*.tsx should match:
    //   - website/src/test.tsx (directly in src/)
    //   - website/src/components/test.tsx (in subdirectory)
    //   - website/src/deep/nested/test.tsx (deeply nested)

    // Use placeholders to avoid replacement conflicts
    const DOUBLE_STAR_SLASH = '\x00DSS\x00';  // Placeholder for **/
    const DOUBLE_STAR = '\x00DS\x00';          // Placeholder for **

    let regexPattern = pattern
        .replace(/\*\*\//g, DOUBLE_STAR_SLASH)  // Mark **/ first
        .replace(/\*\*/g, DOUBLE_STAR)          // Mark remaining **
        .replace(/\./g, '\\.')                  // Escape dots
        .replace(/\*/g, '[^/]*')                // Single * matches anything except /
        .replace(new RegExp(DOUBLE_STAR_SLASH, 'g'), '(?:.*/)?')  // **/ = zero or more dirs
        .replace(new RegExp(DOUBLE_STAR, 'g'), '.*')              // ** = anything
        + '$';

    const regex = new RegExp(regexPattern);
    return regex.test(filePath);
}

function shouldBlockFile(filePath: string, rule: SkillRule): boolean {
    const triggers = rule.fileTriggers;
    if (!triggers) return false;

    // Check path exclusions first
    if (triggers.pathExclusions) {
        for (const exclusion of triggers.pathExclusions) {
            if (matchesGlobPattern(filePath, exclusion)) {
                return false;
            }
        }
    }

    // Check if file matches any path patterns
    if (triggers.pathPatterns) {
        for (const pattern of triggers.pathPatterns) {
            if (matchesGlobPattern(filePath, pattern)) {
                return true;
            }
        }
    }

    return false;
}

function checkFileMarkers(filePath: string, markers: string[]): boolean {
    try {
        if (!existsSync(filePath)) {
            return false;
        }
        const content = readFileSync(filePath, 'utf-8');
        return markers.some(marker => content.includes(marker));
    } catch {
        return false;
    }
}

/**
 * Smart validation for API contract changes
 * Returns true if the change is compliant (should NOT block)
 */
function isApiContractChangeCompliant(skillName: string, toolInput: HookInput['tool_input'], filePath: string): boolean {
    // Only apply to api-contract-validation skill
    if (skillName !== 'api-contract-validation') {
        return false;
    }

    const newString = toolInput.new_string || toolInput.content || '';
    const oldString = (toolInput as any).old_string || '';

    // Read the current file to check context
    let currentFileContent = '';
    try {
        if (existsSync(filePath)) {
            currentFileContent = readFileSync(filePath, 'utf-8');
        }
    } catch {
        // If we can't read the file, allow the change
        return true;
    }

    // If we're just removing an import, allow it
    if (oldString && !newString) {
        return true;
    }

    // If file already imports from @stewra/shared-types, allow changes
    if (currentFileContent.includes('@stewra/shared-types')) {
        return true;
    }

    // If the file is a route file with no type definitions, allow it
    if (filePath.includes('/routes/') && !currentFileContent.match(/(?:interface|type)\s+\w+(?:Request|Response|Params|Query|Body)/)) {
        return true;
    }

    // If the change includes imports from @stewra/shared-types, it's likely compliant
    if (newString.includes('@stewra/shared-types')) {
        // Check if it's NOT adding new local API type definitions
        const hasLocalApiTypes = /(?:interface|type)\s+\w+(?:Request|Response|Params|Query|Body)/.test(newString);

        // If using shared-types AND not adding local types, it's compliant
        if (!hasLocalApiTypes) {
            return true;
        }
    }

    // If using z.nativeEnum with imported enums from shared-types, it's compliant
    if (newString.includes('z.nativeEnum(') && currentFileContent.includes('@stewra/shared-types')) {
        return true;
    }

    // If the new string is removing imports from local types and adding shared-types, it's compliant
    if (newString.includes('@stewra/shared-types') && !newString.includes('from \'../../types/')) {
        return true;
    }

    return false;
}

async function main() {
    try {
        // Read input from stdin
        const input = readFileSync(0, 'utf-8');
        const data: HookInput = JSON.parse(input);

        // Only check Edit, Write, and MultiEdit operations
        if (!['Edit', 'Write', 'MultiEdit'].includes(data.tool_name)) {
            process.exit(0);
        }

        const filePath = data.tool_input.file_path;
        if (!filePath) {
            process.exit(0);
        }

        // Get project directory from environment
        const projectDir = process.env.CLAUDE_PROJECT_DIR;
        if (!projectDir) {
            console.error('Error: CLAUDE_PROJECT_DIR environment variable is not set');
            process.exit(0); // Fail open - allow operation if environment is not configured
        }

        // Load skill rules
        const rulesPath = join(projectDir, '.claude', 'skills', 'skill-rules.json');
        const rules: SkillRules = JSON.parse(readFileSync(rulesPath, 'utf-8'));

        // Find ALL guardrail skills with block enforcement
        const guardrailSkills: Array<{ name: string; rule: SkillRule }> = [];
        for (const [skillName, rule] of Object.entries(rules.skills)) {
            if (rule.type === 'guardrail' && rule.enforcement === 'block') {
                guardrailSkills.push({ name: skillName, rule });
            }
        }

        // No guardrails configured
        if (guardrailSkills.length === 0) {
            process.exit(0);
        }

        // Check each guardrail skill
        for (const { name: skillName, rule } of guardrailSkills) {
            // Check if file should be blocked by this guardrail
            if (!shouldBlockFile(filePath, rule)) {
                continue;
            }

            // Check skip conditions
            const skipConditions = rule.skipConditions;
            if (skipConditions) {
                // Check environment override
                if (skipConditions.envOverride && process.env[skipConditions.envOverride]) {
                    continue;
                }

                // Check file markers
                if (skipConditions.fileMarkers && checkFileMarkers(filePath, skipConditions.fileMarkers)) {
                    continue;
                }

                // Check if skill was used in this session
                if (skipConditions.sessionSkillUsed) {
                    const sessionMarkerPath = join(
                        projectDir,
                        '.claude',
                        'hooks',
                        '.session-skills',
                        data.session_id,
                        skillName
                    );
                    if (existsSync(sessionMarkerPath)) {
                        continue;
                    }
                }
            }

            // Smart validation: Check if the change is actually compliant
            if (isApiContractChangeCompliant(skillName, data.tool_input, filePath)) {
                continue; // Change is compliant, don't block
            }

            // Block the operation with this guardrail's message
            const blockMessage = rule.blockMessage ||
                `⚠️ BLOCKED - Best Practices Required\n\n` +
                `📋 REQUIRED ACTION:\n` +
                `1. Use Skill tool: '${skillName}'\n` +
                `2. Review best practices\n` +
                `3. Then retry this edit\n\n` +
                `Reason: Enforce best practices\n` +
                `File: ${filePath}`;

            // Replace {file_path} placeholder in message
            const finalMessage = blockMessage.replace('{file_path}', filePath);

            console.error(finalMessage);
            process.exit(2); // Exit code 2 is required to block PreToolUse operations
        }

        // No guardrails matched - allow the operation
        process.exit(0);

    } catch (err) {
        console.error('Error in dev-guardrail hook:', err);
        // On error, allow the operation (fail open)
        process.exit(0);
    }
}

main().catch(err => {
    console.error('Uncaught error:', err);
    process.exit(0);
});
