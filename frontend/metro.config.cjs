const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// This app lives inside the Stewra npm workspace monorepo and depends on the
// sibling @stewra/shared-types package — Metro must watch the repo root and
// resolve node_modules from both the app and the workspace root (npm
// workspaces hoist shared deps to the root node_modules).
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// Keep hierarchical (walk-up) lookup ENABLED. Some react-native transitive deps
// (e.g. @react-native/virtualized-lists) are not hoisted to a listed root and
// stay nested under react-native/node_modules; disabling hierarchical lookup
// would restrict resolution to nodeModulesPaths only and fail to find them.

module.exports = config;
