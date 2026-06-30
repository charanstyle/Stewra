#!/usr/bin/env node
import { readFileSync } from 'fs';

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
        old_string?: string;
        edits?: Array<{ file_path?: string; old_string?: string; new_string?: string }>;
    };
}

interface AntiPattern {
    pattern: RegExp;
    name: string;
    description: string;
    examples: string[];
}

const ANTI_PATTERNS: AntiPattern[] = [
    {
        pattern: /:\s*any(?!\w)/g,
        name: "'any' type",
        description: "Using 'any' type defeats TypeScript's type safety",
        examples: [
            "const data: any = ...",
            "function foo(param: any) { ... }",
            "let result: any;"
        ]
    },
    {
        pattern: /(?<!import \* )(?<!export \* )\sas\s+(?!const\s)/g,
        name: "Type assertions (as)",
        description: "Type assertions bypass type checking and can hide errors",
        examples: [
            "const foo = bar as string",
            "return data as MyType",
            "(value as number) + 1"
        ]
    },
    {
        pattern: /<[^>]+>\s*\(\s*(?![a-zA-Z_$][\w$.]*\s*\()/g,
        name: "Angle bracket type casting",
        description: "Angle bracket syntax for type casting bypasses type checking",
        examples: [
            "<string>value",
            "<MyType>(data)",
            "const foo = <number>bar"
        ]
    },
    {
        pattern: /Record\s*<\s*string\s*,\s*unknown\s*>/g,
        name: "Record<string, unknown>",
        description: "Using Record<string, unknown> provides weak typing and should be avoided",
        examples: [
            "const obj: Record<string, unknown> = ...",
            "function foo(params: Record<string, unknown>) { ... }"
        ]
    }
];

function detectAntiPatterns(content: string): Array<{ pattern: AntiPattern; matches: string[] }> {
    const detected: Array<{ pattern: AntiPattern; matches: string[] }> = [];

    // For type assertion checks, filter out import/export lines, comments, and generic function calls
    let contentToCheck = content;
    if (content.includes(' as ') || content.includes('<')) {
        const lines = content.split('\n');
        const filteredLines = lines.filter(line => {
            const trimmed = line.trim();
            // Exclude import/export lines with 'as'
            if (trimmed.startsWith('import ') || trimmed.startsWith('export ')) {
                return false;
            }
            // Exclude comment lines (both // and /* */ style)
            if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
                return false;
            }
            // Exclude lines with 'as const'
            if (/ as const\b/.test(line)) {
                return false;
            }
            // Exclude lines with 'as keyof' (legitimate TypeScript pattern)
            if (/ as keyof /.test(line)) {
                return false;
            }
            // Exclude generic function calls like functionName<Type>( or object.method<Type>(
            if (/[a-zA-Z_$][\w$.]*<[^>]+>\s*\(/.test(line)) {
                return false;
            }
            // Exclude JSX component tags (start with capital letter)
            if (/<[A-Z][a-zA-Z0-9]*[\s>]/.test(line) || /<\/[A-Z][a-zA-Z0-9]*>/.test(line)) {
                return false;
            }
            // Exclude JSX elements with common React Native/React props
            if (/<[a-z][a-z0-9]*[\s>]/.test(line) && /style=|className=|onClick=|onPress=|key=|ref=|testID=/.test(line)) {
                return false;
            }
            // Exclude lines where 'as' only appears inside string literals (e.g. SQL/Kysely aliases: 'table as alias')
            if (/ as /.test(line)) {
                const withoutStrings = line.replace(/'[^']*'/g, '""').replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '""');
                if (!/ as /.test(withoutStrings)) {
                    return false;
                }
            }
            // Exclude Kysely .as() method calls (column aliasing, not type assertions)
            if (/\.as\s*\(/.test(trimmed) && !/ as /.test(line.replace(/\.as\s*\(/g, '.ALIAS('))) {
                return false;
            }
            return true;
        });
        contentToCheck = filteredLines.join('\n');
    }

    for (const antiPattern of ANTI_PATTERNS) {
        const matches = contentToCheck.match(antiPattern.pattern);
        if (matches && matches.length > 0) {
            detected.push({
                pattern: antiPattern,
                matches: [...new Set(matches)] // Remove duplicates
            });
        }
    }

    return detected;
}

function formatBlockMessage(filePath: string, detections: Array<{ pattern: AntiPattern; matches: string[] }>): string {
    let message = `\n⛔ TYPESCRIPT ANTI-PATTERN DETECTED\n\n`;
    message += `File: ${filePath}\n\n`;
    message += `❌ The following TypeScript anti-patterns were found:\n\n`;

    for (const detection of detections) {
        message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        message += `🚫 ${detection.pattern.name}\n`;
        message += `   ${detection.pattern.description}\n\n`;
        message += `   Found instances:\n`;
        for (const match of detection.matches) {
            message += `   • ${match.trim()}\n`;
        }
        message += `\n   ✅ Recommended alternatives:\n`;
        for (const example of detection.pattern.examples) {
            message += `   ❌ DON'T: ${example}\n`;
        }
        message += `\n`;
    }

    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `\n📋 REQUIRED ACTION:\n`;
    message += `1. Define proper TypeScript interfaces/types\n`;
    message += `2. Use strong typing instead of 'any' or type assertions\n`;
    message += `3. For objects, create specific interfaces instead of Record<string, unknown>\n`;
    message += `4. Retry the edit with proper types\n\n`;
    message += `💡 TIP: If you need flexible types, consider:\n`;
    message += `   • unknown (for truly unknown values - requires type guards)\n`;
    message += `   • Specific union types (e.g., string | number | boolean)\n`;
    message += `   • Branded types for specific use cases\n`;
    message += `   • Generic constraints (e.g., <T extends BaseType>)\n\n`;

    return message;
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

        // Only check TypeScript/JavaScript files
        if (!filePath.match(/\.(ts|tsx|js|jsx)$/)) {
            process.exit(0);
        }

        // Exclude test files and type definition files
        if (filePath.includes('.test.') || filePath.includes('.spec.') || filePath.endsWith('.d.ts')) {
            process.exit(0);
        }

        // Exclude node_modules and hooks directory
        if (filePath.includes('node_modules') || filePath.includes('/.claude/hooks/')) {
            process.exit(0);
        }

        // Get the content being written/edited
        let contentToCheck = '';

        if (data.tool_name === 'Write') {
            contentToCheck = data.tool_input.content || '';
        } else if (data.tool_name === 'MultiEdit') {
            // MultiEdit has an edits[] array with individual new_string per edit
            contentToCheck = (data.tool_input.edits || [])
                .map(edit => edit.new_string || '')
                .join('\n');
        } else if (data.tool_name === 'Edit') {
            contentToCheck = data.tool_input.new_string || '';
        }

        if (!contentToCheck) {
            process.exit(0);
        }

        // Detect anti-patterns
        const detections = detectAntiPatterns(contentToCheck);

        if (detections.length > 0) {
            const blockMessage = formatBlockMessage(filePath, detections);
            console.error(blockMessage);
            process.exit(2); // Exit code 2 blocks the operation
        }

        // No anti-patterns found - allow the operation
        process.exit(0);

    } catch (err) {
        console.error('Error in typescript-antipattern-blocker hook:', err);
        // On error, allow the operation (fail open)
        process.exit(0);
    }
}

main().catch(err => {
    console.error('Uncaught error:', err);
    process.exit(0);
});
