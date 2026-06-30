#!/usr/bin/env node
/**
 * PostToolUse hook - Tracks when skills are used in a session
 * Creates marker files that allow dev-guardrail.ts to skip blocks
 */

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

interface ToolInput {
    skill?: string;
    prompt?: string;
    description?: string;
    subagent_type?: string;
}

interface HookInput {
    session_id: string;
    transcript_path: string;
    cwd: string;
    permission_mode: string;
    tool_name: string;
    tool_input: ToolInput;
}

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
            process.exit(0);
        }

        // Get project directory
        const projectDir = process.env.CLAUDE_PROJECT_DIR;
        if (!projectDir) {
            console.error('CLAUDE_PROJECT_DIR not set');
            process.exit(0);
        }

        // session_id is required to scope the marker; bail cleanly if absent
        // (expected condition outside a real session — fail open, no noise)
        const sessionId = data.session_id;
        if (!sessionId) {
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

        mkdirSync(sessionDir, { recursive: true });

        // Create marker file for this skill
        const markerPath = join(sessionDir, skillName);
        writeFileSync(markerPath, new Date().toISOString());

        console.error(`✅ Skill usage tracked: ${skillName}`);
        process.exit(0);

    } catch (err) {
        console.error('Error in track-skill-usage hook:', err);
        process.exit(0); // Fail open
    }
}

main().catch(err => {
    console.error('Uncaught error:', err);
    process.exit(0);
});
