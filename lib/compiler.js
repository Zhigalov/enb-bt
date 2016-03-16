var vow = require('vow'),
    enb = require('enb'),
    vfs = enb.asyncFS || require('enb/lib/fs/async-fs'),
    File = require('enb-source-map/lib/file'),
    EOL = require('os').EOL,
    browserify = require('browserify'),
    promisify = require('vow-node').promisify;

/**
 * @namespace BTCompiler
 */
module.exports = {
    compile: compile
};

/**
 * Compiles code of BT module with core and source templates.<br/><br/>
 *
 * The compiled BT module supports CommonJS and YModules. If there is no any modular system in the runtime,
 * the module will be provided as global variable `BT`.
 *
 * @memberof BTCompiler
 *
 * @param {Array.<{path: String, contents: String}>} sources Files with source templates.
 * @param {Object}   opts
 * @param {String}   opts.filename              Path to a compiled file.
 * @param {String}   opts.dirname               Path to a directory with compiled file.
 * @param {String}   opts.bhFilename            Path to file with BT core.
 * @param {Object}   [opts.requires]            Names for dependencies to `BT.lib.name`.
 * @param {String[]} [opts.mimic]               Names for export.
 * @param {String}   [opts.scope=template]      Scope of templates execution.
 * @param {Boolean}  [opts.sourcemap=false]     Includes inline source maps.
 * @param {String}   [opts.btOptions]           Sets options for BT core.
 *
 * @returns {String} compiled code of BT module.
 */
function compile(sources, opts) {
    opts || (opts = {});

    /* istanbul ignore if */
    if (!opts.filename) {
        throw new Error('The `filename` option is not specified!');
    }

    var file = new File(opts.filename, opts.sourcemap),
        isTemplateScope = opts.hasOwnProperty('scope') ? opts.scope === 'template' : true,
        mimic = opts.mimic || [],
        requires = opts.requires || {};

    return vow.all([
        getBTCoreSource(opts.btFilename),
        compileCommonJS(requires, opts.dirname)
    ]).spread(function (core, commonJSProvides) {
        // IIFE start
        file.writeLine('(function (global) {');

        // Core
        file.writeFileContent(core.path, core.contents);
        file.writeLine([
            'var bt = new BT();',
            'bt.setOptions(' + JSON.stringify(opts.btOptions) + ');'
        ].join(EOL));

        // `init()` will be called after all the dependencies (bt.lib) will be provided
        // wrap in function scope not to pollute templates scope
        file.writeLine('var init = function (global, BT) {');
        sources.forEach(function (source) {
            var relPath = source.relPath || source.path;

            // wrap in IIFE to perform each template in its scope
            isTemplateScope && file.writeLine('(function () {');
            file.writeLine('// begin: ' + relPath);
            file.writeFileContent(source.path, source.contents);
            file.writeLine('// end: ' + relPath);
            isTemplateScope && file.writeLine('}());');
        });
        file.writeLine('};');

        // Export bt
        file.writeLine([
            commonJSProvides,
            'var defineAsGlobal = true;',
            // Provide to YModules
            'if (typeof modules === "object") {',
            compileYModule('BT', requires, true),
            mimic.map(function (name) {
                return name === 'BT' ? '' : compileYModule(name, 'BT');
            }).join(EOL),
            '    defineAsGlobal = false;',

            // Provide with CommonJS
            '} else if (typeof exports === "object") {',
            '    init();',
            mimic.map(function (name) {
                return '    bt["' + name + '"] = bt;';
            }).join(EOL),
            '    module.exports = bt;',
            '    defineAsGlobal = false;',
            '}',

            // Provide to Global Scope
            'if (defineAsGlobal) {',
            Object.keys(requires).map(function (name) {
                var item = requires[name];

                if (item.globals) {
                    return '    bt.lib.' + name + ' = global' + compileGlobalAccessor(item.globals) + ';';
                }
            }).join(EOL),
            '    init();',
            '    global.BT = bt;',
            mimic.map(function (name) {
                return '    global["' + name + '"] = bt;';
            }).join(EOL),
            '}'
        ].join(EOL));
        // IIFE finish
        file.writeLine('}(typeof window !== "undefined" ? window : global));');

        return file.render();
    });
}

/**
 * Reads code of BT core.
 *
 * @ignore
 * @param {String} filename — path to file with BT core.
 * @returns {{ path: String, contents: String }}
 */
function getBTCoreSource(filename) {
    return vfs.read(filename, 'utf-8')
        .then(function (contents) {
            return {
                path: filename,
                contents: contents
            };
        });
}

/**
 * Compiles code with YModule definition that exports BT module.
 *
 * @ignore
 * @param {String}   name        Module name.
 * @param {Object}   [requires]  Names for requires to `bt.lib.name`.
 * @returns {String}
 */
function compileYModule(name, requires) {
    var modules = [],
        deps = [],
        globals = {},
        needInit = true;

    if (requires === 'BT') {
        modules = ['BT'];
        needInit = false;
    } else {
        requires && Object.keys(requires).forEach(function (name) {
            var item = requires[name];

            if (item.ym) {
                modules.push(item.ym);
                deps.push(name);
            } else if (item.globals) {
                globals[name] = item.globals;
            }
        });
    }

    return [
        '    modules.define("' + name + '"' + (modules ? ', ' + JSON.stringify(modules) : '') +
            ', function(provide' + (deps && deps.length ? ', ' + deps.join(', ') : '') + ') {',
            deps.map(function (name) {
                return '        bt.lib.' + name + ' = ' + name + ';';
            }).join(EOL),
            Object.keys(globals).map(function (name) {
                return '        bt.lib.' + name + ' = global' + compileGlobalAccessor(globals[name]) + ';';
            }).join(EOL),
            needInit ? 'init();' : '',
        '        provide(bt);',
        '    });'
    ].join(EOL);
}

/**
 * Compiles with provide modules to CommonJS.
 *
 * @ignore
 * @param {Object}   [requires] Names for requires to `bt.lib.name`.
 * @param {String}   [dirname]  Path to a directory with compiled file.
 * @returns {String}
 */

function compileCommonJS(requires, dirname) {
    var browserifyOptions = {
            basedir: dirname
        },
        renderer = browserify(browserifyOptions),
        bundle = promisify(renderer.bundle.bind(renderer)),
        provides = [],
        hasCommonJSRequires = false;

    Object.keys(requires).map(function (name) {
        var item = requires[name];

        if (item.commonJS) {
            renderer.require(item.commonJS);
            provides.push('bt.lib.' + name + ' = require("' + item.commonJS + '");');
            hasCommonJSRequires = true;
        } else if (item.globals) {
            provides.push('bt.lib.' + name + ' = global' + compileGlobalAccessor(item.globals) + ';');
        }
    });

    if (!hasCommonJSRequires) {
        return vow.resolve(provides.join(EOL));
    }

    return bundle()
        .then(function (buf) {
            return [
                '(function () {',
                'var ' + buf.toString('utf-8'),
                provides.join(EOL),
                '}());'
            ].join(EOL);
        });
}

/**
 * Compiles accessor path of the `global` object.
 *
 * @ignore
 * @param {String} value  Dot delimited accessor path
 * @returns {String}
 */
function compileGlobalAccessor(value) {
    return '["' + value.split('.').join('"]["') + '"]';
}
