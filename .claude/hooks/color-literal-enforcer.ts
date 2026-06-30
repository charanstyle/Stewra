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

interface ColorViolation {
    line: number;
    content: string;
    color: string;
    property: string;
}

// Allowed color literals (case-insensitive)
const ALLOWED_COLORS = [
    'transparent',
    '#000',
    '#000000',
];

// Color properties to check
const COLOR_PROPERTIES = [
    'backgroundColor',
    'color',
    'borderColor',
    'borderTopColor',
    'borderBottomColor',
    'borderLeftColor',
    'borderRightColor',
    'tintColor',
    'overlayColor',
    'shadowColor', // Only '#000' allowed for shadows
];

/**
 * Check if a color value is allowed
 */
function isAllowedColor(colorValue: string, property: string): boolean {
    const normalized = colorValue.trim().toLowerCase();

    // 'transparent' is allowed everywhere
    if (normalized === 'transparent') {
        return true;
    }

    // '#000' and '#000000' are ONLY allowed for shadowColor
    if (normalized === '#000' || normalized === '#000000') {
        return property === 'shadowColor';
    }

    // Allow theme.colors.* references
    if (normalized.includes('theme.colors.')) {
        return true;
    }

    return false;
}

/**
 * Extract color literals from code
 */
function findColorLiterals(code: string): ColorViolation[] {
    const violations: ColorViolation[] = [];
    const lines = code.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;

        // Skip comments
        if (line.trim().startsWith('//') || line.trim().startsWith('/*') || line.trim().startsWith('*')) {
            continue;
        }

        // Check each color property
        for (const property of COLOR_PROPERTIES) {
            // Match: backgroundColor: '#HEX' or backgroundColor: 'colorname' or backgroundColor: 'rgb(...)'
            const patterns = [
                // Hex colors: #RGB, #RRGGBB, #RRGGBBAA
                new RegExp(`${property}\\s*:\\s*['"]\\s*(#[0-9a-fA-F]{3,8})\\s*['"]`, 'g'),
                // Named colors: 'red', 'blue', 'white', etc (but not 'transparent')
                new RegExp(`${property}\\s*:\\s*['"]\\s*([a-z]+)\\s*['"]`, 'gi'),
                // rgb/rgba functions
                new RegExp(`${property}\\s*:\\s*['"]\\s*(rgba?\\([^)]+\\))\\s*['"]`, 'g'),
            ];

            for (const pattern of patterns) {
                let match;
                while ((match = pattern.exec(line)) !== null) {
                    const colorValue = match[1];

                    // Check if this color is allowed
                    if (!isAllowedColor(colorValue, property)) {
                        violations.push({
                            line: lineNumber,
                            content: line.trim(),
                            color: colorValue,
                            property: property,
                        });
                    }
                }
            }
        }
    }

    return violations;
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

        // Only check frontend TypeScript/TSX files
        if (!filePath.includes('/frontend/') || !filePath.match(/\.(ts|tsx)$/)) {
            process.exit(0);
        }

        // Skip test files
        if (filePath.includes('.test.') || filePath.includes('.spec.')) {
            process.exit(0);
        }

        // Get the code being added/modified
        let codeToCheck = '';
        if (data.tool_name === 'MultiEdit') {
            codeToCheck = (data.tool_input.edits || [])
                .map(edit => edit.new_string || '')
                .join('\n');
        } else {
            codeToCheck = data.tool_input.new_string || data.tool_input.content || '';
        }

        if (!codeToCheck) {
            process.exit(0);
        }

        // Find color literal violations
        const violations = findColorLiterals(codeToCheck);

        if (violations.length > 0) {
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('❌ BLOCKED - Color Literal Violation');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('');
            console.error(`File: ${filePath}`);
            console.error(`Found ${violations.length} prohibited color literal(s):`);
            console.error('');

            for (const violation of violations) {
                console.error(`  Line ${violation.line}: ${violation.property}: '${violation.color}'`);
                console.error(`    ${violation.content}`);
                console.error('');
            }

            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('📋 ALLOWED color literals:');
            console.error('   ✅ \'transparent\' - standard CSS keyword');
            console.error('   ✅ \'#000\' or \'#000000\' - for shadowColor only');
            console.error('   ✅ theme.colors.* - theme color references');
            console.error('');
            console.error('❌ PROHIBITED (use theme.colors instead):');
            console.error('   ❌ \'#FF5733\', \'#FFF\', \'#FFFFFF\' (hex colors)');
            console.error('   ❌ \'red\', \'blue\', \'white\' (named colors)');
            console.error('   ❌ \'rgb(255,0,0)\', \'rgba(0,0,0,0.5)\' (rgb functions)');
            console.error('');
            console.error('💡 Example fixes:');
            console.error('   backgroundColor: \'#FFFFFF\'  →  backgroundColor: theme.colors.background');
            console.error('   color: \'red\'                →  color: theme.colors.error');
            console.error('   borderColor: \'#E0E0E0\'     →  borderColor: theme.colors.border');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

            process.exit(2); // Exit code 2 blocks the operation
        }

        // No violations - allow the operation
        process.exit(0);

    } catch (err) {
        console.error('Error in color-literal-enforcer hook:', err);
        // On error, allow the operation (fail open)
        process.exit(0);
    }
}

main().catch(err => {
    console.error('Uncaught error:', err);
    process.exit(0);
});
