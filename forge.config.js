const { WebpackPlugin } = require('@electron-forge/plugin-webpack');
const path = require('path');

const mainConfig = require('./webpack.main.config');
const rendererConfig = require('./webpack.renderer.config');

module.exports = {
  packagerConfig: {
    name: 'Aurum Signals FX Bot',
    executableName: 'aurum-signals-fx-bot',
    asar: true,
    icon: path.join(__dirname, 'assets', 'icon'),
    appBundleId: 'com.aurumsignals.fxbot',
    appCategoryType: 'public.app-category.finance',
    win32metadata: {
      CompanyName: 'Aurum Signals',
      ProductName: 'Aurum Signals FX Bot',
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'aurum_signals_fx_bot',
        setupExe: 'AurumSignalsFXBotSetup.exe',
        setupIcon: path.join(__dirname, 'assets', 'icon.ico'),
        loadingGif: path.join(__dirname, 'assets', 'install.gif'),
      },
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        name: 'Aurum Signals FX Bot',
        icon: path.join(__dirname, 'assets', 'icon.icns'),
        overwrite: true,
        format: 'ULFO',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-webpack',
      config: {
        mainConfig,
        devContentSecurityPolicy:
          "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        renderer: {
          config: rendererConfig,
          entryPoints: [
            {
              html: './src/renderer/index.html',
              js: './src/renderer/index.tsx',
              name: 'main_window',
              preload: {
                js: './src/preload/index.ts',
              },
            },
          ],
        },
      },
    },
  ],
};
