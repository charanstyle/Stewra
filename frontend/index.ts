import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App) and
// also ensures the environment is set up appropriately, whether running in Expo Go,
// a native dev-client build, or a bare workflow build.
registerRootComponent(App);
