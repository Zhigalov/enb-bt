var vow = require('vow'),
    enb = require('enb'),
    vfs = enb.asyncFS || require('enb/lib/fs/async-fs'),
    buildFlow = enb.buildFlow || require('enb/lib/build-flow'),
    compile = require('../lib/compiler').compile;

/**
 * @class BTBundleTech
 * @augments {BaseTech}
 * @classdesc
 *
 * Build file with CommonJS requires for core and each BT template (`bt.js` files).<br/><br/>
 *
 * Use in browsers and on server side (Node.js).<br/><br/>
 *
 * The compiled BT module supports CommonJS and YModules. If there is no any modular system in the runtime,
 * the module will be provided as global variable `BT`.<br/><br/>
 *
 * Important: do not use `require` in templates.
 *
 * @param {Object}      [options]                           Options
 * @param {String}      [options.target='?.bt.js']          Path to a target with compiled file.
 * @param {String}      [options.filesTarget='?.files']     Path to a target with FileList.
 * @param {String[]}    [options.sourceSuffixes='bt.js']    Files with specified suffixes involved in the assembly.
 * @param {String}      [options.btFilename]                Path to file with BT core.
 * @param {Object}      [options.requires]                  Names for dependencies to `BT.lib.name`.
 * @param {String[]}    [options.mimic]                     Names for export.
 * @param {String}      [options.scope='template']          Scope of template execution.
 * @param {Boolean}     [options.sourcemap=false]           Includes inline source maps.
 * @param {Object}      [options.btOptions={}]              Sets option for BT core.
 *
 * @example
 * var BTBundleTech = require('enb-bt/techs/bt-bundle'),
 *     FileProvideTech = require('enb/techs/file-provider'),
 *     bemTechs = require('enb-bem-techs');
 *
 * module.exports = function(config) {
 *     config.node('bundle', function(node) {
 *         // get FileList
 *         node.addTechs([
 *             [FileProvideTech, { target: '?.bemdecl.js' }],
 *             [bemTechs.levels, { levels: ['blocks'] }],
 *             [bemTechs.deps],
 *             [bemTechs.files]
 *         ]);
 *
 *         // build BT file
 *         node.addTech(BTBundleTech);
 *         node.addTarget('?.bt.js');
 *     });
 * };
 */
module.exports = buildFlow.create()
    .name('bt-bundle')
    .target('target', '?.bt.js')
    .defineOption('btFilename', require.resolve('../lib/bt.js'))
    .defineOption('requires', {})
    .defineOption('mimic', ['bt'])
    .defineOption('btOptions', {})
    .defineOption('sourcemap', false)
    .defineOption('scope', 'template')
    .useFileList(['bt.js'])
    .needRebuild(function (cache) {
        return cache.needRebuildFile('bt-file', this._btFilename);
    })
    .saveCache(function (cache) {
        cache.cacheFileInfo('bt-file', this._btFilename);
    })
    .builder(function (files) {
        return this._readTemplates(files)
            .then(function (sources) {
                return this._compile(sources);
            }, this);
    })
    .methods(/** @lends BTBundleTech.prototype */{
        /**
         * Compiles code of BT module with core and source templates.
         *
         * @see BTCompiler.compile
         * @protected
         * @param {Array.<{path: String, contents: String}>} sources — Files with source templates.
         * @returns {String} compiled code of bt module
         */
        _compile: function (sources) {
            var opts = {
                filename: this.node.resolvePath(this._target),
                dirname: this.node.getDir(),
                btFilename: this._btFilename,
                sourcemap: this._sourcemap,
                scope: this._scope,
                mimic: [].concat(this._mimic),
                requires: this._requires,
                btOptions: this._btOptions
            };

            return compile(sources, opts);
        },
        /**
         * Reads files with source templates.
         *
         * @protected
         * @param {FileList} files
         * @returns {Array.<{path: String, relPath: String, contents: String}>}
         */
        _readTemplates: function (files) {
            var node = this.node,
                process = this._processTemplate;

            return vow.all(files.map(function (file) {
                return vfs.read(file.fullname, 'utf8')
                    .then(function (contents) {
                        return {
                            path: file.fullname,
                            relPath: node.relativePath(file.fullname),
                            contents: process(contents)
                        };
                    });
            }));
        },
        /**
         * Adapts single BT file content to client side.
         *
         * @protected
         * @param {String} contents — Contents of a source file.
         * @returns {String}
         */
        _processTemplate: function (contents) {
            return contents
                .replace(/module\.exports\s*=\s*function\s*\([^\)]*\)\s*\{/, '')
                .replace(/}\s*(?:;)?\s*$/, '');
        }
    })
    .createTech();
