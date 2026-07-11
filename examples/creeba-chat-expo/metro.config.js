// Learn more: https://docs.expo.dev/guides/monorepos/
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
// Repo root (examples/creeba-chat-expo -> creeba). The local packages
// `creeba-js` and `creeba-expo` are linked from here and live outside the app.
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch the whole repo so edits in the linked packages trigger fast refresh.
config.watchFolders = [workspaceRoot];

// The linked packages ship their OWN node_modules with mismatched copies of
// react / react-native / expo-modules-core (e.g. RN 0.82 vs the app's 0.86).
// Bundling those produces a second React Native whose TurboModule registry is
// not wired to the native binary -> "PlatformConstants could not be found".
// Hide them from Metro entirely (also avoids Haste name collisions).
const previousBlockList = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(previousBlockList)
    ? previousBlockList
    : previousBlockList
      ? [previousBlockList]
      : []),
  /[/\\]creeba-expo[/\\]node_modules[/\\].*/,
  /[/\\]creeba-js[/\\]node_modules[/\\].*/,
];

// Resolve every shared dependency from the app's node_modules so the JS bundle
// matches the native binary that was built.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];
config.resolver.extraNodeModules = {
  react: path.resolve(projectRoot, "node_modules/react"),
  "react-native": path.resolve(projectRoot, "node_modules/react-native"),
  expo: path.resolve(projectRoot, "node_modules/expo"),
  "expo-modules-core": path.resolve(projectRoot, "node_modules/expo-modules-core"),
};

module.exports = config;
