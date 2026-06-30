#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

interface HookInput {
    session_id: string;
    transcript_path: string;
    cwd: string;
    permission_mode: string;
    tool_name: string;
    tool_input: {
        skill?: string;
        [key: string]: unknown;
    };
}

/**
 * PostToolUse hook that tracks Skill tool usage to create session markers.
 * This prevents guardrail hooks from re-blocking after a skill has been activated.
 *
 * Flow:
 * 1. User gets skill suggestion → uses Skill tool
 * 2. This hook creates marker: .claude/hooks/.session-skills/{session_id}/{skillName}
 * 3. PreToolUse hooks (dev-guardrail.ts, etc.) check for marker
 * 4. If marker exists → skip blocking (session-aware)
 */
async function main() {
    try {
        // Read input from stdin
        const input = readFileSync(0, 'utf-8');
        const data: HookInput = JSON.parse(input);

        // Only track Skill tool usage
        if (data.tool_name !== 'Skill') {
            process.exit(0);
        }

        const skillName = data.tool_input.skill;
        if (!skillName) {
            // No skill name provided - exit cleanly
            process.exit(0);
        }

        // Get project directory from environment
        const projectDir = process.env.CLAUDE_PROJECT_DIR;
        if (!projectDir) {
            console.error('Warning: CLAUDE_PROJECT_DIR not set, cannot track skill usage');
            process.exit(0); // Fail open - don't block on missing env
        }

        const sessionId = data.session_id;
        if (!sessionId) {
            // Expected condition outside a real session — fail open silently
            process.exit(0);
        }

        // Create session marker directory
        const sessionDir = join(
            projectDir,
            '.claude',
            'hooks',
            '.session-skills',
            sessionId
        );

        try {
            mkdirSync(sessionDir, { recursive: true });
        } catch (err) {
            console.error(`Warning: Failed to create session directory: ${err}`);
            process.exit(0);
        }

        // Create marker file for this skill
        const markerPath = join(sessionDir, skillName);
        const timestamp = new Date().toISOString();
        const markerContent = `${timestamp}\nSkill activated: ${skillName}\nSession: ${sessionId}\n`;

        try {
            writeFileSync(markerPath, markerContent, 'utf-8');
            // Success - marker created (silent, no output to user)
        } catch (err) {
            console.error(`Warning: Failed to write session marker: ${err}`);
        }

        // Exit cleanly - PostToolUse hooks don't block
        process.exit(0);

    } catch (err) {
        console.error('Error in skill-usage-tracker hook:', err);
        // Fail open on error
        process.exit(0);
    }
}

main().catch(err => {
    console.error('Uncaught error:', err);
    process.exit(0);
});
