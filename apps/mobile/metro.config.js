const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Privy's React Native SDK depends on jose@4, which imports Node's `crypto`
// module in its default (node) build. Metro's default resolver doesn't
// apply the `browser` package-exports condition, so it picks that node
// build and fails (`crypto` doesn't exist in React Native). Forcing the
// `browser` condition only for `jose` makes it resolve to its WebCrypto
// build instead -- react-native-get-random-values (already imported in
// app/_layout.tsx) supplies the crypto.getRandomValues WebCrypto needs.
// See https://docs.privy.io/basics/react-native/installation
const resolveRequestWithPackageExports = (context, moduleName, platform) => {
  if (moduleName === 'jose') {
    const ctx = { ...context, unstable_conditionNames: ['browser'] };
    return ctx.resolveRequest(ctx, moduleName, platform);
  }

  if (moduleName.startsWith('@privy-io/')) {
    const ctx = { ...context, unstable_enablePackageExports: true };
    return ctx.resolveRequest(ctx, moduleName, platform);
  }

  return context.resolveRequest(context, moduleName, platform);
};

config.resolver.resolveRequest = resolveRequestWithPackageExports;

module.exports = config;
