import fs from 'fs';
import path from 'path';
import rimraf from 'rimraf';
import mkdirp from 'mkdirp';
import chalk from 'chalk';
import ora from 'ora';
import hasha from 'hasha';
import yargs from 'yargs-parser';
import resolveFrom from 'resolve-from';
import babelPresetEnv from '@babel/preset-env';
import isNodeBuiltin from 'is-builtin-module';

import * as rollup from 'rollup';
import rollupPluginNodeResolve from '@rollup/plugin-node-resolve';
import rollupPluginCommonjs from '@rollup/plugin-commonjs';
import {terser as rollupPluginTerser} from 'rollup-plugin-terser';
import rollupPluginReplace from '@rollup/plugin-replace';
import rollupPluginJson from '@rollup/plugin-json';
import rollupPluginBabel from 'rollup-plugin-babel';
import {rollupPluginTreeshakeInputs} from './rollup-plugin-treeshake-inputs.js';
import {rollupPluginDependencyInfo, DependencyInfoOutput} from './rollup-plugin-dependency-info.js';
import {scanImports, scanDepList, InstallTarget} from './scan-imports.js';

export interface DependencyLoc {
  type: 'JS' | 'ASSET';
  loc: string;
}

export interface InstallOptions {
  destLoc: string;
  include?: string;
  isStrict?: boolean;
  isOptimized?: boolean;
  isBabel?: boolean;
  hasBrowserlistConfig?: boolean;
  isExplicit?: boolean;
  withStats?: boolean;
  namedExports?: {[filepath: string]: string[]};
  nomodule?: string;
  nomoduleOutput?: string;
  externalPackages: string[];
  sourceMap?: boolean | 'inline';
  dedupe?: string[];
}

const ALWAYS_SHOW_ERRORS = new Set(['react', 'react-dom']);
const cwd = process.cwd();
const banner = chalk.bold(`snowpack`) + ` installing... `;
const installResults = [];
let dependencyInfo: DependencyInfoOutput = null;
let spinner = ora(banner);
let spinnerHasError = false;

function printHelp() {
  console.log(
    `
${chalk.bold(`snowpack`)} - Install npm dependencies to run natively on the web.
${chalk.bold('Options:')}
    --dest              Specify destination directory (default: "web_modules/").
    --clean             Clear out the destination directory before install.
    --optimize          Transpile, minify, and optimize installed dependencies for production.
    --babel             Transpile installed dependencies. Also enabled with "--optimize".
    --include           Auto-detect imports from file(s). Supports glob.
    --exclude           Exclude files from --include. Follows glob’s ignore pattern.
    --strict            Only install pure ESM dependency trees. Fail if a CJS module is encountered.
    --no-source-map     Skip emitting source map files (.js.map) into dest
${chalk.bold('Advanced:')}
    --nomodule          Your app’s entry file for generating a <script nomodule> bundle
    --nomodule-output   Filename for nomodule output (default: 'app.nomodule.js')
    --external-package  [Internal use only.] May go away at any time.    
    `.trim(),
  );
}

async function generateHashFromFile(targetLoc) {
  const longHash = await hasha.fromFile(targetLoc, {algorithm: 'md5'});
  return longHash.slice(0, 10);
}

function formatInstallResults(skipFailures): string {
  return installResults
    .map(([d, yn]) => (yn ? chalk.green(d) : skipFailures ? chalk.dim(d) : chalk.red(d)))
    .join(', ');
}

function formatDependencyInfoAnalysis(): string {
  let output = '';
  const {direct, shared} = dependencyInfo;
  const formatFileInfo = files =>
    files.map((file, index) => {
      const {fileName, size, delta} = file;
      let fileInfo = `${index >= files.length - 1 ? '└─' : '├─'} ${fileName} [${size / 1000} KB`;
      fileInfo +=
        delta !== 0 ? `,  Δ ${delta > 0 ? '+' : ''}${Math.round(delta * 100) / 100} KB` : '';
      fileInfo += ']';
      return fileInfo;
    });
  output += 'Direct dependences: web_modules/\n';
  output += formatFileInfo(Object.values(direct)).join('\n');
  if (Object.values(shared).length > 0) {
    output += '\nShared dependencies: web_modules/common/\n';
    output += formatFileInfo(Object.values(shared)).join('\n');
  }
  return output;
}

function logError(msg) {
  if (!spinnerHasError) {
    spinner.stopAndPersist({symbol: chalk.cyan('⠼')});
  }
  spinnerHasError = true;
  spinner = ora(chalk.red(msg));
  spinner.fail();
}

class ErrorWithHint extends Error {
  constructor(message: string, public readonly hint: string) {
    super(message);
  }
}

// Add common, well-used non-esm packages here so that Rollup doesn't die trying to analyze them.
const PACKAGES_TO_AUTO_DETECT_EXPORTS = [
  path.join('react', 'index.js'),
  path.join('react-dom', 'index.js'),
  path.join('react-is', 'index.js'),
  path.join('prop-types', 'index.js'),
  path.join('rxjs', 'Rx.js'),
];

function detectExports(filePath: string): string[] | undefined {
  try {
    const fileLoc = resolveFrom(cwd, filePath);
    if (fs.existsSync(fileLoc)) {
      return Object.keys(require(fileLoc)).filter(e => e[0] !== '_');
    }
  } catch (err) {
    // ignore
  }
}

/**
 * Resolve a "webDependencies" input value to the correct absolute file location.
 * Supports both npm package names, and file paths relative to the node_modules directory.
 * Follows logic similar to Node's resolution logic, but using a package.json's ESM "module"
 * field instead of the CJS "main" field.
 */
function resolveWebDependency(dep: string, isExplicit: boolean): DependencyLoc {
  // if dep includes a file extension, check that dep isn't a package before returning
  const depManifestLoc = resolveFrom.silent(cwd, `${dep}/package.json`);
  if (path.extname(dep) && !resolveFrom.silent(cwd, `${dep}/package.json`)) {
    const isJSFile = ['.js', '.mjs', '.cjs'].includes(path.extname(dep));
    return {
      type: isJSFile ? 'JS' : 'ASSET',
      loc: resolveFrom(cwd, dep),
    };
  }
  if (!depManifestLoc) {
    throw new ErrorWithHint(
      `"${dep}" not found. Have you installed the package via npm?`,
      chalk.italic(depManifestLoc),
    );
  }
  const depManifest = require(depManifestLoc);
  let foundEntrypoint: string =
    depManifest['browser:module'] || depManifest.module || depManifest.browser;
  // If the package was a part of the explicit whitelist, fallback to it's main CJS entrypoint.
  if (!foundEntrypoint && isExplicit) {
    foundEntrypoint = depManifest.main || 'index.js';
  }
  if (
    (dep === 'react' || dep === 'react-dom') &&
    (!foundEntrypoint || foundEntrypoint === 'index.js')
  ) {
    throw new ErrorWithHint(
      chalk.bold(`Dependency "${dep}" has no native "module" entrypoint.`) +
        `
  To continue, install our drop-in, ESM-ready builds of "react" & "react-dom" to your project:
    npm: npm install react@npm:@pika/react react-dom@npm:@pika/react-dom
    yarn: yarn add react@npm:@pika/react react-dom@npm:@pika/react-dom`,
      chalk.italic(`See ${chalk.underline('https://www.snowpack.dev/#react')} for more info.`),
    );
  }
  if (!foundEntrypoint) {
    throw new ErrorWithHint(
      `dependency "${dep}" has no native "module" entrypoint.`,
      chalk.italic(
        `Tip: Find modern, web-ready packages at ${chalk.underline('https://www.pika.dev')}`,
      ),
    );
  }
  return {
    type: 'JS',
    loc: path.join(depManifestLoc, '..', foundEntrypoint),
  };
}

/**
 * Formats the snowpack dependency name from a "webDependencies" input value:
 * 2. Remove any ".js"/".mjs" extension (will be added automatically by Rollup)
 */
function getWebDependencyName(dep: string): string {
  return dep.replace(/\.m?js$/i, '');
}

export async function install(installTargets: InstallTarget[], installOptions: InstallOptions) {
  const {
    destLoc,
    hasBrowserlistConfig,
    isExplicit,
    isStrict,
    isBabel,
    isOptimized,
    withStats,
    sourceMap,
    namedExports,
    nomodule,
    nomoduleOutput,
    externalPackages,
    dedupe,
  } = installOptions;
  const knownNamedExports = {...namedExports};
  for (const filePath of PACKAGES_TO_AUTO_DETECT_EXPORTS) {
    knownNamedExports[filePath] = knownNamedExports[filePath] || detectExports(filePath) || [];
  }
  if (!fs.existsSync(path.join(cwd, 'node_modules'))) {
    logError('no "node_modules" directory exists. Did you run "npm install" first?');
    return;
  }
  const allInstallSpecifiers = new Set(installTargets.map(dep => dep.specifier));
  const depObject: {[targetName: string]: string} = {};
  const assetObject: {[targetName: string]: string} = {};
  const importMap = {};
  const installTargetsMap = {};
  const skipFailures = !isExplicit;
  for (const installSpecifier of allInstallSpecifiers) {
    try {
      const targetName = getWebDependencyName(installSpecifier);
      const {type: targetType, loc: targetLoc} = resolveWebDependency(installSpecifier, isExplicit);
      if (targetType === 'JS') {
        const hash = await generateHashFromFile(targetLoc);
        depObject[targetName] = targetLoc;
        importMap[targetName] = `./${targetName}.js?rev=${hash}`;
        installTargetsMap[targetLoc] = installTargets.filter(t => installSpecifier === t.specifier);
        installResults.push([installSpecifier, true]);
      } else if (targetType === 'ASSET') {
        assetObject[targetName] = targetLoc;
        installResults.push([installSpecifier, true]);
      }
      spinner.text = banner + formatInstallResults(skipFailures);
    } catch (err) {
      installResults.push([installSpecifier, false]);
      spinner.text = banner + formatInstallResults(skipFailures);
      if (skipFailures && !ALWAYS_SHOW_ERRORS.has(installSpecifier)) {
        continue;
      }
      // An error occurred! Log it.
      logError(err.message || err);
      if (err.hint) {
        console.log(err.hint);
      }
      return false;
    }
  }
  if (Object.keys(depObject).length === 0 && Object.keys(assetObject).length === 0) {
    logError(`No ESM dependencies found!`);
    console.log(
      chalk.dim(
        `  At least one dependency must have an ESM "module" entrypoint. You can find modern, web-ready packages at ${chalk.underline(
          'https://www.pika.dev',
        )}`,
      ),
    );
    return false;
  }

  const inputOptions = {
    input: depObject,
    external: externalPackages,
    plugins: [
      !isStrict &&
        rollupPluginReplace({
          'process.env.NODE_ENV': isOptimized ? '"production"' : '"development"',
        }),
      rollupPluginNodeResolve({
        mainFields: ['browser:module', 'module', 'browser', !isStrict && 'main'].filter(Boolean),
        modulesOnly: isStrict, // Default: false
        extensions: ['.mjs', '.cjs', '.js', '.json'], // Default: [ '.mjs', '.js', '.json', '.node' ]
        // whether to prefer built-in modules (e.g. `fs`, `path`) or local ones with the same names
        preferBuiltins: false, // Default: true
        dedupe,
      }),
      !isStrict &&
        rollupPluginJson({
          preferConst: true,
          indent: '  ',
          compact: isOptimized,
          namedExports: true,
        }),
      !isStrict &&
        rollupPluginCommonjs({
          extensions: ['.js', '.cjs'], // Default: [ '.js' ]
          namedExports: knownNamedExports,
        }),
      !!isBabel &&
        rollupPluginBabel({
          compact: false,
          babelrc: false,
          configFile: false,
          presets: [
            [
              babelPresetEnv,
              {
                modules: false,
                targets: hasBrowserlistConfig
                  ? undefined
                  : '>0.75%, not ie 11, not UCAndroid >0, not OperaMini all',
              },
            ],
          ],
        }),
      !!isOptimized && rollupPluginTreeshakeInputs(installTargets),
      !!isOptimized && rollupPluginTerser(),
      !!withStats && rollupPluginDependencyInfo(info => (dependencyInfo = info)),
    ],
    onwarn: ((warning, warn) => {
      if (warning.code === 'UNRESOLVED_IMPORT') {
        logError(
          `'${warning.source}' is imported by '${warning.importer}', but could not be resolved.`,
        );
        if (isNodeBuiltin(warning.source)) {
          console.log(
            chalk.dim(
              `  '${
                warning.source
              }' is a Node.js builtin module that won't exist on the web. You can find modern, web-ready packages at ${chalk.underline(
                'https://www.pika.dev',
              )}`,
            ),
          );
        } else {
          console.log(
            chalk.dim(`  Make sure that the package is installed and that the file exists.`),
          );
        }
        return;
      }
      warn(warning);
    }) as any,
  };
  const outputOptions = {
    dir: destLoc,
    format: 'esm' as 'esm',
    sourcemap: sourceMap === undefined ? isOptimized : sourceMap,
    exports: 'named' as 'named',
    chunkFileNames: 'common/[name]-[hash].js',
  };
  if (Object.keys(depObject).length > 0) {
    const packageBundle = await rollup.rollup(inputOptions);
    await packageBundle.write(outputOptions);
  }
  if (nomodule) {
    const nomoduleStart = Date.now();
    function rollupResolutionHelper() {
      return {
        name: 'rename-import-plugin',
        resolveId(source) {
          // resolve from import map
          if (importMap[source]) {
            return importMap[source];
          }
          // resolve web_modules
          if (source.includes('/web_modules/')) {
            const suffix = source.split('/web_modules/')[1];
            return {id: path.join(destLoc, suffix)};
          }
          // null means try to resolve as-is
          return null;
        },
      };
    }
    try {
      const noModuleBundle = await rollup.rollup({
        input: nomodule,
        inlineDynamicImports: true,
        plugins: [...inputOptions.plugins, rollupResolutionHelper()],
      });
      await noModuleBundle.write({file: path.resolve(destLoc, nomoduleOutput), format: 'iife'});
      const nomoduleEnd = Date.now() - nomoduleStart;
      spinner.info(
        `${chalk.bold(
          'snowpack',
        )} bundled your application for legacy browsers: ${nomoduleOutput} ${chalk.dim(
          `[${(nomoduleEnd / 1000).toFixed(2)}s]`,
        )}`,
      );
    } catch (err) {
      spinner.warn(
        `${chalk.bold('snowpack')} encountered an error bundling for legacy browsers: ${
          err.message
        }`,
      );
    }
  }
  fs.writeFileSync(
    path.join(destLoc, 'import-map.json'),
    JSON.stringify({imports: importMap}, undefined, 2),
    {encoding: 'utf8'},
  );
  Object.entries(assetObject).forEach(([assetName, assetLoc]) => {
    mkdirp.sync(path.dirname(`${destLoc}/${assetName}`));
    fs.copyFileSync(assetLoc, `${destLoc}/${assetName}`);
  });
  return true;
}

export async function cli(args: string[]) {
  const {
    help,
    sourceMap,
    babel = false,
    exclude = ['**/__tests__/*', '**/*.@(spec|test).@(js|mjs)'],
    include,
    nomodule,
    nomoduleOutput = 'app.nomodule.js',
    optimize = false,
    stat = false,
    strict = false,
    clean = false,
    dest = 'web_modules',
    externalPackage: externalPackages = [],
  } = yargs(args, {array: ['externalPackage']});
  const destLoc = path.resolve(cwd, dest);

  if (help) {
    printHelp();
    process.exit(0);
  }

  let pkgManifest: any;
  try {
    pkgManifest = require(path.join(cwd, 'package.json'));
  } catch (err) {
    console.log(chalk.red('[ERROR] package.json required but no file was found.'));
    process.exit(0);
  }

  const implicitDependencies = [
    ...Object.keys(pkgManifest.dependencies || {}),
    ...Object.keys(pkgManifest.peerDependencies || {}),
  ];
  const allDependencies = [
    ...Object.keys(pkgManifest.dependencies || {}),
    ...Object.keys(pkgManifest.peerDependencies || {}),
    ...Object.keys(pkgManifest.devDependencies || {}),
  ];
  const hasBrowserlistConfig =
    !!pkgManifest.browserslist ||
    !!process.env.BROWSERSLIST ||
    fs.existsSync(path.join(cwd, '.browserslistrc')) ||
    fs.existsSync(path.join(cwd, 'browserslist'));

  let isExplicit = false;
  const installTargets = [];
  const {namedExports, webDependencies, dedupe} = pkgManifest['snowpack'] || {
    namedExports: undefined,
    webDependencies: undefined,
    dedupe: undefined,
  };

  if (pkgManifest['@pika/web']) {
    console.log(
      '[WARN] Update package.json "@pika/web" configuration to use "snowpack" configuration name.',
    );
  }
  if (webDependencies) {
    isExplicit = true;
    installTargets.push(...scanDepList(webDependencies, cwd));
  }
  if (include) {
    isExplicit = true;
    installTargets.push(...scanImports({include, exclude, knownDependencies: allDependencies}));
  }
  if (!webDependencies && !include) {
    installTargets.push(...scanDepList(implicitDependencies, cwd));
  }
  if (installTargets.length === 0) {
    logError('Nothing to install.');
    return;
  }
  if (clean) {
    rimraf.sync(destLoc);
  }

  spinner.start();
  const startTime = Date.now();
  const installOptions = {
    destLoc,
    namedExports,
    isExplicit,
    isStrict: strict,
    isBabel: babel || optimize,
    isOptimized: optimize,
    withStats: stat,
    nomodule,
    nomoduleOutput,
    sourceMap,
    hasBrowserlistConfig,
    externalPackages,
    dedupe: dedupe || [],
  };
  const result = await install(installTargets, installOptions);
  if (result) {
    spinner.succeed(
      chalk.bold(`snowpack`) +
        ` installed: ` +
        formatInstallResults(!isExplicit) +
        '.' +
        chalk.dim(` [${((Date.now() - startTime) / 1000).toFixed(2)}s]`),
    );
    if (!!dependencyInfo) {
      console.log(formatDependencyInfoAnalysis());
    }
  }

  //If an error happened, set the exit code so that programmatic usage of the CLI knows.
  if (spinnerHasError) {
    spinner.warn(chalk(`Finished with warnings.`));
    process.exitCode = 1;
  }
}
