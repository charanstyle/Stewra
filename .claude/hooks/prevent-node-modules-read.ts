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
        path?: string;
        pattern?: string;
        content?: string;
        command?: string;
    };
}

async function main() {
    try {
        // Read input from stdin
        const input = readFileSync(0, 'utf-8');
        const data: HookInput = JSON.parse(input);

        // Only check Read, Glob, Grep, Bash, Write, and Edit operations
        if (!['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit'].includes(data.tool_name)) {
            process.exit(0);
        }

        // Get the path or command being accessed (different for each tool)
        let pathToCheck = '';

        if (data.tool_name === 'Read' || data.tool_name === 'Write' || data.tool_name === 'Edit') {
            pathToCheck = data.tool_input.file_path || '';
        } else if (data.tool_name === 'Glob') {
            // Check both path and pattern for Glob
            pathToCheck = (data.tool_input.path || '') + ' ' + (data.tool_input.pattern || '');
        } else if (data.tool_name === 'Grep') {
            pathToCheck = data.tool_input.path || '';
        } else if (data.tool_name === 'Bash') {
            // For Bash, check the command string for node_modules references
            const command = data.tool_input.command || '';

            // Allow certain safe commands that might mention node_modules
            const allowedCommands = [
                /^npm\s+install/,
                /^npm\s+ci/,
                /^npx\s+/,
                /^yarn\s+install/,
                /^pnpm\s+install/,
                /^rm\s+-rf.*node_modules/,  // Allow deleting node_modules
                /^ls\s+-la?\s*$/,           // Allow bare ls commands
                /^pwd\s*$/,                  // Allow pwd
                /^git\s+/,                   // Allow git commands
            ];

            // Check if command is in allowed list
            for (const allowed of allowedCommands) {
                if (allowed.test(command)) {
                    process.exit(0);
                }
            }

            // Now check if command references node_modules
            if (command.includes('node_modules')) {
                console.error('❌ BLOCKED: Bash command accessing node_modules is not allowed');
                console.error('');
                console.error(`Attempted command: ${command}`);
                console.error('');
                console.error('Please use official package documentation or source repositories instead.');
                process.exit(2);
            }

            // If no node_modules reference, allow
            process.exit(0);
        }

        // Check if path contains node_modules (for Read/Glob/Grep)
        if (pathToCheck.includes('node_modules')) {
            console.error('❌ BLOCKED: Access to node_modules directories is not allowed');
            console.error('');
            console.error('This includes:');
            console.error('  - /node_modules/');
            console.error('  - backend/node_modules/');
            console.error('  - frontend/node_modules/');
            console.error('  - website/node_modules/');
            console.error('  - packages/*/node_modules/');
            console.error('  - .claude/hooks/node_modules/');
            console.error('  - **/node_modules/ (any subdirectory)');
            console.error('');
            console.error('Please use official package documentation or source repositories instead.');
            console.error('');
            console.error(`Attempted path: ${pathToCheck}`);
            process.exit(2); // Exit code 2 is required to block PreToolUse operations
        }

        // Allow the operation
        process.exit(0);

    } catch (err) {
        console.error('Error in prevent-node-modules-read hook:', err);
        // On error, allow the operation (fail open)
        process.exit(0);
    }
}

main().catch(err => {
    console.error('Uncaught error:', err);
    process.exit(0);
});
