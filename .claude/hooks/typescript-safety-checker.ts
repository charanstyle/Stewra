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
        old_string?: string;
    };
}

interface TypeSafetyViolation {
    type: 'any' | 'type-assertion' | 'angle-bracket-cast' | 'non-null-assertion' | 'weak-type';
    line: number;
    content: string;
    context: string;
}

interface ValidationResult {
    isValid: boolean;
    violations: TypeSafetyViolation[];
}

/**
 * Check if a file path is a TypeScript file
 */
function isTypeScriptFile(filePath: string): boolean {
    return filePath.endsWith('.ts') || filePath.endsWith('.tsx');
}

/**
 * Check if file should be excluded from checks
 */
function shouldExcludeFile(filePath: string): boolean {
    // Exclude test files, mock files, type definition files
    const exclusions = [
        '.test.ts',
        '.test.tsx',
        '.spec.ts',
        '.spec.tsx',
        '__tests__',
        '__mocks__',
        '.d.ts',
        'node_modules/',
        'dist/',
        'build/',
        '.next/',
        'coverage/',
        '.claude/', // Exclude hook files and Claude-related files
        // Database utilities need type assertions for dynamic runtime values
        'databaseHelpers.ts',
        // Transformation utilities need type assertions for runtime type conversions
        'typeSafeTransformations.ts'
    ];

    return exclusions.some(exclusion => filePath.includes(exclusion));
}

/**
 * Detect 'any' type usage
 */
function detectAnyTypes(content: string): TypeSafetyViolation[] {
    const violations: TypeSafetyViolation[] = [];
    const lines = content.split('\n');

    // Patterns that should NOT be flagged:
    // - Comments: // any or /* any */
    // - String literals: "any" or 'any' or `any`
    // - Words containing 'any': company, many, etc.

    const anyPatterns = [
        // Variable declarations
        /:\s*any\b/,
        // Generic parameters
        /<any>/,
        /<any,/,
        /,\s*any>/,
        // Array types
        /Array<any>/,
        /any\[\]/,
        // Function parameters and return types
        /\(\s*\w+:\s*any\b/,
        /\):\s*any\b/,
        // Type assertions with any
        /as\s+any\b/,
        // Record with any
        /Record<[^,>]+,\s*any>/,
        /Record<any,/,
        // Promise with any
        /Promise<any>/,
        // Explicit any type
        /type\s+\w+\s*=\s*any\b/,
        /interface\s+\w+\s*{\s*\[\w+:\s*\w+\]:\s*any\b/
    ];

    lines.forEach((line, index) => {
        const trimmedLine = line.trim();

        // Skip comments
        if (trimmedLine.startsWith('//') || trimmedLine.startsWith('*') || trimmedLine.startsWith('/*')) {
            return;
        }

        // Remove string literals to avoid false positives
        const lineWithoutStrings = line
            .replace(/"[^"]*"/g, '""')
            .replace(/'[^']*'/g, "''")
            .replace(/`[^`]*`/g, '``');

        // Check each pattern
        for (const pattern of anyPatterns) {
            if (pattern.test(lineWithoutStrings)) {
                violations.push({
                    type: 'any',
                    line: index + 1,
                    content: line.trim(),
                    context: `Line ${index + 1}: ${line.trim()}`
                });
                break; // Only report once per line
            }
        }
    });

    return violations;
}

/**
 * Detect 'as' type assertions
 */
function detectTypeAssertions(content: string): TypeSafetyViolation[] {
    const violations: TypeSafetyViolation[] = [];
    const lines = content.split('\n');

    // Match 'as Type' but exclude 'as const', which is safe.
    // The character class includes '(', ')', ':' and '=' so casts to function
    // types are caught too, e.g. `handler as (...args: unknown[]) => void`
    // (previously these slipped through because '(' was not in the class).
    const typeAssertionPattern = /\s+as\s+(?!const\b)[\w<>\[\](){}|&,.:=\s'"]+/g;

    // Track if we're inside an import statement
    let insideImport = false;

    lines.forEach((line, index) => {
        const trimmedLine = line.trim();

        // Skip comments
        if (trimmedLine.startsWith('//') || trimmedLine.startsWith('*') || trimmedLine.startsWith('/*')) {
            return;
        }

        // Check if we're entering an import statement
        if (/^import\s+(type\s+)?\{?/.test(trimmedLine) || /^import\s+\*\s+as/.test(trimmedLine)) {
            insideImport = true;
        }

        // Check if we're exiting an import statement (line contains closing brace and from keyword)
        if (insideImport && (trimmedLine.includes('} from') || trimmedLine.endsWith(';'))) {
            insideImport = false;
            return; // Skip this line too since it is the closing line
        }

        // Skip all lines that are part of import statements
        if (insideImport) {
            return;
        }

        // Remove string literals
        const lineWithoutStrings = line
            .replace(/"[^"]*"/g, '""')
            .replace(/'[^']*'/g, "''")
            .replace(/`[^`]*`/g, '``');

        const matches = lineWithoutStrings.matchAll(typeAssertionPattern);
        for (const match of matches) {
            violations.push({
                type: 'type-assertion',
                line: index + 1,
                content: line.trim(),
                context: `Line ${index + 1}: ${line.trim()}`
            });
        }
    });

    return violations;
}

/**
 * Detect angle bracket type casting <Type>value (legacy TypeScript syntax)
 */
function detectAngleBracketCasts(content: string): TypeSafetyViolation[] {
    const violations: TypeSafetyViolation[] = [];
    const lines = content.split('\n');

    // Match <Type>value pattern but exclude:
    // - JSX/TSX elements: <div>, <Component>
    // - Generic function calls: foo<Type>()
    // - Generic type parameters: Response<Type>, Array<Type>
    // - Comparison operators: a < b > c
    const angleBracketPattern = /<(\w+)>\s*(?!\(|\{|<)[^<]/g;

    lines.forEach((line, index) => {
        const trimmedLine = line.trim();

        // Skip comments and JSX
        if (trimmedLine.startsWith('//') ||
            trimmedLine.startsWith('*') ||
            trimmedLine.startsWith('/*') ||
            trimmedLine.startsWith('<') ||
            trimmedLine.includes('</')) {
            return;
        }

        // Remove string literals
        const lineWithoutStrings = line
            .replace(/"[^"]*"/g, '""')
            .replace(/'[^']*'/g, "''")
            .replace(/`[^`]*`/g, '``');

        // Exclude lines that look like JSX
        if (lineWithoutStrings.includes('</') ||
            /return\s*\(?\s*<[A-Z]/.test(lineWithoutStrings)) {
            return;
        }

        // Exclude lines with type annotations (contains : followed by generic types)
        // This covers cases like: res: Response<ApiResponse<ForgotPasswordResponse>>
        if (/:\s*\w+</.test(lineWithoutStrings)) {
            return;
        }

        const matches = lineWithoutStrings.matchAll(angleBracketPattern);
        for (const match of matches) {
            // Additional validation: make sure it's not a comparison operator or type parameter
            const before = lineWithoutStrings.substring(0, match.index || 0).trim();

            // Allow if it's preceded by a type name (generic type parameter)
            // Examples: Response<Type>, Array<Type>, Request<Type>
            if (/\w+$/.test(before)) {
                continue;
            }

            // Block if preceded by assignment, function call, or array access (classic cast positions)
            if (before.endsWith('=') || before.endsWith('(') || before.endsWith('[') || before.endsWith(',') || before.endsWith('return')) {
                violations.push({
                    type: 'angle-bracket-cast',
                    line: index + 1,
                    content: line.trim(),
                    context: `Line ${index + 1}: ${line.trim()}`
                });
            }
        }
    });

    return violations;
}

/**
 * Detect non-null assertion operator (!)
 */
function detectNonNullAssertions(content: string): TypeSafetyViolation[] {
    const violations: TypeSafetyViolation[] = [];
    const lines = content.split('\n');

    // Match non-null assertion: value! or value!.property or value!()
    // But exclude: !== and !==
    const nonNullPattern = /\w+!\s*(?:\.|;|\)|\]|,|}|$)/g;

    lines.forEach((line, index) => {
        const trimmedLine = line.trim();

        // Skip comments
        if (trimmedLine.startsWith('//') || trimmedLine.startsWith('*') || trimmedLine.startsWith('/*')) {
            return;
        }

        // Remove string literals
        let lineWithoutStrings = line
            .replace(/"[^"]*"/g, '""')
            .replace(/'[^']*'/g, "''")
            .replace(/`[^`]*`/g, '``');

        // Remove inline comments (// comments)
        const commentIndex = lineWithoutStrings.indexOf('//');
        if (commentIndex !== -1) {
            lineWithoutStrings = lineWithoutStrings.substring(0, commentIndex);
        }

        // Exclude !== and !==
        const lineWithoutComparison = lineWithoutStrings
            .replace(/!==?/g, '');

        const matches = lineWithoutComparison.matchAll(nonNullPattern);
        for (const match of matches) {
            violations.push({
                type: 'non-null-assertion',
                line: index + 1,
                content: line.trim(),
                context: `Line ${index + 1}: ${line.trim()}`
            });
        }
    });

    return violations;
}

/**
 * Detect weak types like Record<string, unknown> in variable/parameter declarations.
 * These bypass structural typing and should use proper interfaces instead.
 */
function detectWeakTypes(content: string): TypeSafetyViolation[] {
    const violations: TypeSafetyViolation[] = [];
    const lines = content.split('\n');

    const weakTypePatterns = [
        /:\s*Record<string,\s*unknown>/,
        /:\s*Record<string,\s*string\s*\|\s*unknown>/,
        /:\s*\{\s*\[key:\s*string\]:\s*unknown\s*\}/,
    ];

    lines.forEach((line, index) => {
        const trimmedLine = line.trim();

        if (trimmedLine.startsWith('//') || trimmedLine.startsWith('*') || trimmedLine.startsWith('/*')) {
            return;
        }

        if (trimmedLine.startsWith('type ') || trimmedLine.startsWith('interface ') || trimmedLine.startsWith('export type ') || trimmedLine.startsWith('export interface ')) {
            return;
        }

        const lineWithoutStrings = line
            .replace(/"[^"]*"/g, '""')
            .replace(/'[^']*'/g, "''")
            .replace(/`[^`]*`/g, '``');

        for (const pattern of weakTypePatterns) {
            if (pattern.test(lineWithoutStrings)) {
                violations.push({
                    type: 'weak-type',
                    line: index + 1,
                    content: trimmedLine,
                    context: `Line ${index + 1}: ${trimmedLine}`
                });
                break;
            }
        }
    });

    return violations;
}

/**
 * Validate TypeScript safety
 */
function validateTypeScriptSafety(content: string): ValidationResult {
    const allViolations: TypeSafetyViolation[] = [];

    // Detect all types of violations
    allViolations.push(...detectAnyTypes(content));
    allViolations.push(...detectTypeAssertions(content));
    allViolations.push(...detectAngleBracketCasts(content));
    allViolations.push(...detectNonNullAssertions(content));
    allViolations.push(...detectWeakTypes(content));

    // Sort by line number
    allViolations.sort((a, b) => a.line - b.line);

    return {
        isValid: allViolations.length === 0,
        violations: allViolations
    };
}

/**
 * Format violation message
 */
function formatViolations(violations: TypeSafetyViolation[], filePath: string): string {
    const grouped = violations.reduce((acc, violation) => {
        if (!acc[violation.type]) {
            acc[violation.type] = [];
        }
        acc[violation.type].push(violation);
        return acc;
    }, {} as Record<string, TypeSafetyViolation[]>);

    let message = '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    message += '🚫 TYPESCRIPT SAFETY VIOLATION - OPERATION BLOCKED\n';
    message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    message += `File: ${filePath}\n`;
    message += `Total Violations: ${violations.length}\n\n`;

    if (grouped['any']) {
        message += '❌ ANY TYPE USAGE (STRICTLY FORBIDDEN)\n';
        message += `   Found ${grouped['any'].length} instance(s)\n\n`;
        grouped['any'].forEach(v => {
            message += `   ${v.context}\n`;
        });
        message += '\n   ⚠️  CRITICAL: The "any" type is STRICTLY FORBIDDEN in this codebase\n';
        message += '   ✅ Use instead: unknown, object, or create proper interfaces/types\n\n';
    }

    if (grouped['type-assertion']) {
        message += '❌ TYPE ASSERTIONS (as Type)\n';
        message += `   Found ${grouped['type-assertion'].length} instance(s)\n\n`;
        grouped['type-assertion'].forEach(v => {
            message += `   ${v.context}\n`;
        });
        message += '\n   ⚠️  Type assertions bypass TypeScript safety\n';
        message += '   ✅ Use instead: Type guards, proper typing, or "as const"\n\n';
    }

    if (grouped['angle-bracket-cast']) {
        message += '❌ ANGLE BRACKET TYPE CASTING (<Type>value)\n';
        message += `   Found ${grouped['angle-bracket-cast'].length} instance(s)\n\n`;
        grouped['angle-bracket-cast'].forEach(v => {
            message += `   ${v.context}\n`;
        });
        message += '\n   ⚠️  Legacy casting syntax is unsafe\n';
        message += '   ✅ Use instead: Proper type definitions or type guards\n\n';
    }

    if (grouped['non-null-assertion']) {
        message += '❌ NON-NULL ASSERTIONS (!)\n';
        message += `   Found ${grouped['non-null-assertion'].length} instance(s)\n\n`;
        grouped['non-null-assertion'].forEach(v => {
            message += `   ${v.context}\n`;
        });
        message += '\n   ⚠️  Non-null assertions bypass null safety checks\n';
        message += '   ✅ Use instead: Optional chaining (?.), nullish coalescing (??), or proper null checks\n\n';
    }

    if (grouped['weak-type']) {
        message += '❌ WEAK TYPE USAGE (Record<string, unknown> etc.)\n';
        message += `   Found ${grouped['weak-type'].length} instance(s)\n\n`;
        grouped['weak-type'].forEach(v => {
            message += `   ${v.context}\n`;
        });
        message += '\n   ⚠️  Weak types bypass structural typing and lose compile-time safety\n';
        message += '   ✅ Use instead: Define a proper interface or type for the expected shape\n\n';
    }

    message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    message += '📋 REQUIRED ACTIONS:\n';
    message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    message += '1. Review each violation above\n';
    message += '2. Replace unsafe patterns with type-safe alternatives\n';
    message += '3. Ensure all types are properly defined\n';
    message += '4. Retry the operation after fixes\n\n';
    message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    message += '💡 REFERENCE:\n';
    message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    message += 'From CLAUDE.md:\n';
    message += '"TypeScript Types: STRICTLY FORBIDDEN to use \'any\' type anywhere\n';
    message += 'in the codebase. This is a critical rule that must never be violated."\n\n';
    message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

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

        // Only check TypeScript files
        if (!isTypeScriptFile(filePath)) {
            process.exit(0);
        }

        // Exclude certain files
        if (shouldExcludeFile(filePath)) {
            process.exit(0);
        }

        // Get project directory from environment
        const projectDir = process.env.CLAUDE_PROJECT_DIR;
        if (!projectDir) {
            console.error('Error: CLAUDE_PROJECT_DIR environment variable is not set');
            process.exit(0); // Fail open
        }

        // Check for environment override
        if (process.env.SKIP_TYPESCRIPT_SAFETY_CHECK === 'true') {
            process.exit(0);
        }

        // Get file content to check
        let content = '';
        if (data.tool_name === 'Write') {
            content = data.tool_input.content || '';
        } else if (data.tool_name === 'Edit') {
            // For Edit, we need to check the new_string being added
            // We also want to check if the edit is removing violations
            const newString = data.tool_input.new_string || '';
            const oldString = data.tool_input.old_string || '';

            // If both old and new strings exist, check if we're actually fixing violations
            if (oldString && newString) {
                const oldViolations = validateTypeScriptSafety(oldString);
                const newViolations = validateTypeScriptSafety(newString);

                // If the edit reduces violations, allow it
                if (newViolations.violations.length < oldViolations.violations.length) {
                    process.exit(0);
                }

                // If the edit doesn't introduce new violations, allow it
                if (newViolations.violations.length === 0) {
                    process.exit(0);
                }
            }

            // Check the new content
            content = newString;

            // If we're just checking a small edit, also verify the full file won't have issues
            if (existsSync(filePath)) {
                const fullContent = readFileSync(filePath, 'utf-8');
                // Simulate the edit result
                if (oldString) {
                    const simulatedContent = fullContent.replace(oldString, newString);
                    content = simulatedContent;
                } else {
                    content = fullContent + '\n' + newString;
                }
            }
        } else if (data.tool_name === 'MultiEdit') {
            // For MultiEdit, read the existing file
            if (existsSync(filePath)) {
                content = readFileSync(filePath, 'utf-8');
            }
        }

        if (!content) {
            process.exit(0);
        }

        // Validate TypeScript safety
        const result = validateTypeScriptSafety(content);

        // If violations found, block the operation
        if (!result.isValid) {
            const message = formatViolations(result.violations, filePath);
            console.error(message);
            process.exit(2); // Exit code 2 blocks the operation
        }

        // All checks passed
        process.exit(0);

    } catch (err) {
        console.error('Error in typescript-safety-checker hook:', err);
        // On error, allow the operation (fail open)
        process.exit(0);
    }
}

main().catch(err => {
    console.error('Uncaught error:', err);
    process.exit(0);
});
