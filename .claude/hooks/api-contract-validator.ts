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

interface SharedTypesImport {
    found: boolean;
    importedTypes: string[];
    importLine: string;
}

interface ValidationResult {
    isValid: boolean;
    issues: string[];
    warnings: string[];
}

/**
 * Check if a file path represents an API-related file
 */
function isApiRelatedFile(filePath: string): boolean {
    // Backend API files
    if (filePath.includes('backend/src/controllers/') ||
        filePath.includes('backend/src/routes/') ||
        filePath.includes('backend/src/services/')) {
        return true;
    }

    // Frontend service files
    if (filePath.includes('frontend/src/services/')) {
        return true;
    }

    // Website service files
    if (filePath.includes('website/src/services/') ||
        filePath.includes('website/src/app/api/') ||
        filePath.includes('website/src/pages/api/')) {
        return true;
    }

    // Shared types - monitor all TypeScript files in the package
    // This includes api/, models/, schemas/, and any other type definitions
    if (filePath.includes('packages/shared-types/src/') &&
        (filePath.endsWith('.ts') || filePath.endsWith('.tsx'))) {
        return true;
    }

    return false;
}

/**
 * Check if file content contains shared-types imports
 */
function checkSharedTypesImport(content: string): SharedTypesImport {
    const importRegex = /import\s+(?:type\s+)?{([^}]+)}\s+from\s+['"]@stewra\/shared-types(?:\/[^'"]+)?['"]/g;
    const matches = [...content.matchAll(importRegex)];

    if (matches.length === 0) {
        return { found: false, importedTypes: [], importLine: '' };
    }

    const importedTypes: string[] = [];
    let importLine = '';

    for (const match of matches) {
        const types = match[1].split(',').map(t => t.trim());
        importedTypes.push(...types);
        importLine = match[0];
    }

    return { found: true, importedTypes, importLine };
}

/**
 * Check if a type name represents a third-party API mapper
 */
function isThirdPartyApiMapper(typeName: string): boolean {
    // Third-party API integration patterns to exclude
    const thirdPartyPatterns = [
        /^RapidAPI/i,           // RapidAPI types
        /^AmazonPA/i,           // Amazon Product Advertising API
        /^Stripe/i,             // Stripe API
        /^Google/i,             // Google API
        /^Facebook/i,           // Facebook API
        /^Twitter/i,            // Twitter API
        /^LinkedIn/i,           // LinkedIn API
        /^OpenAI/i,             // OpenAI API
        /^DeepSeek/i,           // DeepSeek API
        /^Gemini/i,             // Gemini API
        /^AWS/i,                // AWS API
        /^External\w+/i,        // External* types
        /^ThirdParty/i,         // ThirdParty* types
        /^Vendor/i,             // Vendor* types
    ];

    return thirdPartyPatterns.some(pattern => pattern.test(typeName));
}

/**
 * Check if a type name represents an internal implementation type
 */
function isInternalType(typeName: string, content: string): boolean {
    // Internal Express/Controller types that don't need to be in shared-types
    const internalPatterns = [
        /^Message(Input|Data)$/i,           // MessageInput, MessageData (internal controller types)
        /^Process\w+(Body|Input|Data)$/i,   // ProcessMessageBody, ProcessDataInput (internal processing)
        /^Validate\w+/i,                     // ValidateUserInput (internal validation)
        /^Transform\w+/i,                    // TransformData (internal transformations)
        /^Internal\w+/i,                     // Internal* types
        /^\w+Validator$/i,                   // *Validator types
        /^\w+Handler$/i,                     // *Handler types
    ];

    if (internalPatterns.some(pattern => pattern.test(typeName))) {
        return true;
    }

    // Check if type is used only internally (not exported)
    const typeDefPattern = new RegExp(`(?:interface|type)\\s+${typeName}\\s*[={]`, 'g');
    const exportPattern = new RegExp(`export\\s+(?:interface|type)\\s+${typeName}`, 'g');

    // If defined but not exported, it's internal
    return typeDefPattern.test(content) && !exportPattern.test(content);
}

/**
 * Check if a type name represents a legitimate public API contract
 */
function isPublicApiContract(typeName: string, content: string): boolean {
    // Explicitly exported API contracts
    const exportPattern = new RegExp(`export\\s+(?:interface|type)\\s+${typeName}`, 'g');
    if (exportPattern.test(content)) {
        return true;
    }

    // Types that clearly represent API endpoints
    const publicApiPatterns = [
        /^Create\w+Request$/i,    // CreateUserRequest
        /^Update\w+Request$/i,    // UpdateUserRequest
        /^Delete\w+Request$/i,    // DeleteUserRequest
        /^Get\w+Request$/i,       // GetUserRequest
        /^List\w+Request$/i,      // ListUsersRequest
        /^Search\w+Request$/i,    // SearchUsersRequest
        /^\w+ApiRequest$/i,       // UserApiRequest
        /^\w+ApiResponse$/i,      // UserApiResponse
    ];

    return publicApiPatterns.some(pattern => pattern.test(typeName));
}

/**
 * Analyze API contract usage patterns
 */
function analyzeApiContract(content: string, filePath: string): ValidationResult {
    const issues: string[] = [];
    const warnings: string[] = [];

    // Check if file has a marker comment to skip API contract validation
    if (content.includes('// @skip-api-contract-validation') ||
        content.includes('/* @skip-api-contract-validation */')) {
        return { isValid: true, issues: [], warnings: [] };
    }

    // Check for shared-types import
    const sharedTypesImport = checkSharedTypesImport(content);

    // Backend controller/service validation
    if (filePath.includes('backend/src/')) {
        // Extract all type names to analyze
        const typeNamePattern = /(?:interface|type)\s+(\w+(?:Request|Response|Params|Body|Query))\s*[={]/g;
        const allTypes = [...content.matchAll(typeNamePattern)];

        // Filter to only public API contracts (exclude third-party and internal types)
        const publicApiTypes = allTypes
            .map(match => match[1])
            .filter(typeName =>
                !isThirdPartyApiMapper(typeName) &&
                !isInternalType(typeName, content) &&
                isPublicApiContract(typeName, content)
            );

        // Block when public API types are defined without a shared-types import
        if (publicApiTypes.length > 0 && !sharedTypesImport.found) {
            issues.push(
                '🚫 Public API contracts defined without shared-types import',
                '   Move these types to @stewra/shared-types and import them here:',
                '   Types: ' + publicApiTypes.join(', ')
            );
        }

        // Check for exported inline type definitions
        const exportedInlineTypes = allTypes
            .filter(match => {
                const typeName = match[1];
                const exportPattern = new RegExp(`export\\s+(?:interface|type)\\s+${typeName}`, 'g');
                return exportPattern.test(content) &&
                       !isThirdPartyApiMapper(typeName) &&
                       !isInternalType(typeName, content);
            });

        if (exportedInlineTypes.length > 0 && !filePath.includes('packages/shared-types')) {
            issues.push(
                '🚫 Exported API type definitions outside shared-types package',
                `   Found ${exportedInlineTypes.length} exported type(s). Move them to shared-types package`,
                '   Types found: ' + exportedInlineTypes.map(m => m[1]).join(', ')
            );
        }
    }

    // Frontend service validation
    if (filePath.includes('frontend/src/services/') || filePath.includes('website/src/')) {
        // Check for API calls without shared-types
        const hasApiCalls = /(?:fetch|axios|api\.)\s*\(/g.test(content);

        if (hasApiCalls && !sharedTypesImport.found) {
            issues.push(
                '🚫 API calls without shared-types import',
                '   Frontend/Website services must import types from @stewra/shared-types',
                '   This ensures type consistency with backend contracts'
            );
        }
    }

    // Shared-types API contract validation
    if (filePath.includes('packages/shared-types/src/api/')) {
        // This is good - API contracts being defined in the right place
        // Check for proper naming conventions
        const hasProperNaming = /(?:interface|type)\s+\w+(?:Request|Response|Params|Query|Body)\s/g.test(content);

        if (!hasProperNaming && content.includes('export')) {
            warnings.push(
                '⚠️  API contract naming convention',
                '   Consider using suffixes: Request, Response, Params, Query, Body',
                '   Example: CreateUserRequest, GetUserResponse, UpdateUserParams'
            );
        }
    }

    return {
        isValid: issues.length === 0,
        issues,
        warnings
    };
}

/**
 * Check cross-project consistency
 */
async function checkCrossProjectConsistency(filePath: string, content: string, projectDir: string): Promise<ValidationResult> {
    const issues: string[] = [];
    const warnings: string[] = [];

    try {
        // Extract API type names from content
        const apiTypePattern = /(?:interface|type)\s+(\w+(?:Request|Response|Params|Query|Body))/g;
        const apiTypes = [...content.matchAll(apiTypePattern)].map(m => m[1]);

        if (apiTypes.length === 0) {
            return { isValid: true, issues: [], warnings: [] };
        }

        // Check if these types exist in shared-types
        const sharedTypesApiDir = join(projectDir, 'packages', 'shared-types', 'src', 'api');

        if (!existsSync(sharedTypesApiDir)) {
            warnings.push(
                '⚠️  Cannot verify shared-types consistency',
                '   Shared-types API directory not found',
                `   Expected: ${sharedTypesApiDir}`
            );
            return { isValid: true, issues: [], warnings };
        }

        // Read all API contract files in shared-types
        const { readdirSync } = await import('fs');
        const { join: pathJoin, basename } = await import('path');
        const apiFiles = readdirSync(sharedTypesApiDir)
            .filter((f: string) => f.endsWith('.ts'))
            .map((f: string) => pathJoin(sharedTypesApiDir, f));

        // Build a map of type name to file
        const sharedTypesMap = new Map<string, string>();

        for (const apiFile of apiFiles) {
            const apiContent = readFileSync(apiFile, 'utf-8');
            const types = [...apiContent.matchAll(apiTypePattern)].map(m => m[1]);
            for (const type of types) {
                sharedTypesMap.set(type, basename(apiFile));
            }
        }

        // Check if types being used are defined in shared-types (excluding third-party mappers and internal types)
        const missingTypes: string[] = [];
        for (const type of apiTypes) {
            if (!sharedTypesMap.has(type) &&
                !isThirdPartyApiMapper(type) &&
                !isInternalType(type, content) &&
                isPublicApiContract(type, content)) {
                missingTypes.push(type);
            }
        }

        if (missingTypes.length > 0 && !filePath.includes('packages/shared-types/src/api/')) {
            issues.push(
                '🚫 Public API types not defined in shared-types package',
                '   These types must live in packages/shared-types/src/api/:',
                '   Missing types: ' + missingTypes.join(', '),
                '',
                '   📋 REQUIRED ACTIONS:',
                '   1. Define these types in appropriate file under packages/shared-types/src/api/',
                '   2. Export them from the API contract file',
                '   3. Rebuild shared-types: cd packages/shared-types && npm run build',
                '   4. Import and use them in your code'
            );
        }

    } catch (error) {
        warnings.push(
            '⚠️  Error checking cross-project consistency',
            `   ${error instanceof Error ? error.message : String(error)}`
        );
    }

    return {
        isValid: issues.length === 0,
        issues,
        warnings
    };
}

/**
 * Main validation function
 */
async function validateApiContract(filePath: string, content: string, projectDir: string): Promise<ValidationResult> {
    const allIssues: string[] = [];
    const allWarnings: string[] = [];

    // Analyze the current file
    const analysisResult = analyzeApiContract(content, filePath);
    allIssues.push(...analysisResult.issues);
    allWarnings.push(...analysisResult.warnings);

    // Check cross-project consistency
    const consistencyResult = await checkCrossProjectConsistency(filePath, content, projectDir);
    allIssues.push(...consistencyResult.issues);
    allWarnings.push(...consistencyResult.warnings);

    return {
        isValid: allIssues.length === 0,
        issues: allIssues,
        warnings: allWarnings
    };
}

async function main() {
    try {
        // Read input from stdin
        const input = readFileSync(0, 'utf-8');
        const data: HookInput = JSON.parse(input);

        // Only check Edit and Write operations
        if (!['Edit', 'Write', 'MultiEdit'].includes(data.tool_name)) {
            process.exit(0);
        }

        const filePath = data.tool_input.file_path;
        if (!filePath) {
            process.exit(0);
        }

        // Only check API-related files
        if (!isApiRelatedFile(filePath)) {
            process.exit(0);
        }

        // Get project directory from environment
        const projectDir = process.env.CLAUDE_PROJECT_DIR;
        if (!projectDir) {
            console.error('Error: CLAUDE_PROJECT_DIR environment variable is not set');
            process.exit(0); // Fail open
        }

        // Get file content
        let content = '';
        if (data.tool_name === 'Write') {
            content = data.tool_input.content || '';
        } else if (data.tool_name === 'Edit') {
            // For Edit, we need to check the new content
            content = data.tool_input.new_string || '';
            // Also read existing file to get full context
            if (existsSync(filePath)) {
                const existingContent = readFileSync(filePath, 'utf-8');
                content = existingContent + '\n' + content;
            }
        }

        if (!content) {
            process.exit(0);
        }

        // Check if API contract validation should be skipped via environment variable
        if (process.env.SKIP_API_CONTRACT_VALIDATION === 'true') {
            process.exit(0);
        }

        // Check session marker to avoid repeated blocking
        const sessionMarkerDir = join(projectDir, '.claude', 'hooks', '.session-skills', data.session_id);
        const sessionMarkerPath = join(sessionMarkerDir, 'api-contract-validation');

        if (existsSync(sessionMarkerPath)) {
            // Skill was already used in this session, allow the operation
            process.exit(0);
        }

        // Validate the API contract
        const result = await validateApiContract(filePath, content, projectDir);

        // Display warnings (non-blocking)
        if (result.warnings.length > 0) {
            console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('⚠️  API CONTRACT WARNINGS');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
            console.error('File: ' + filePath);
            console.error('');
            result.warnings.forEach(warning => console.error(warning));
            console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        }

        // If there are blocking issues, prevent the operation
        if (!result.isValid) {
            console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('🚫 API CONTRACT VALIDATION FAILED');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
            console.error('File: ' + filePath);
            console.error('');
            result.issues.forEach(issue => console.error(issue));
            console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('📚 Use Skill tool: "api-contract-validation"');
            console.error('   Review shared-types usage guidelines');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            process.exit(2); // Exit code 2 blocks the operation
        }

        // All checks passed
        process.exit(0);

    } catch (err) {
        console.error('Error in api-contract-validator hook:', err);
        // On error, allow the operation (fail open)
        process.exit(0);
    }
}

main().catch(err => {
    console.error('Uncaught error:', err);
    process.exit(0);
});
