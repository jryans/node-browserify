var detective = require('detective');
var resolve = require('resolve');

var fs = require('fs');
var path = require('path');

var wrappers = require('./wrappers');

module.exports = Wrap;
function Wrap () {
    if (!(this instanceof Wrap)) return new Wrap();
    
    this.files = {};
    this.filters = [];
    this.postFilters = [];
    this.preFilters = [];
    this.aliases = {};
    
    this.ignoring = {};
    this.extensions = [ '.js' ];
    
    this.prepends = [ wrappers.prelude, wrappers.process ];
    this.appends = []
    this.entries = {};
    
    this.require([ 'path' ]);
    
    this._checkedPackages = {};
}

Wrap.prototype.prepend = function (src) {
    this.prepends.unshift(src);
    return this;
};

Wrap.prototype.append = function (src) {
    this.appends.push(src);
    return this;
};

Wrap.prototype.ignore = function (files) {
    if (!files) files = [];
    if (!Array.isArray(files)) files = [ files ];
    
    this.ignoring = files.reduce(function (acc,x) {
        acc[x] = true;
        return acc;
    }, {});
    
    return this;
};

Wrap.prototype.use = function (fn) {
    fn(this, this);
    return this;
};

Wrap.prototype.register = function (ext, fn) {
    if (typeof ext === 'object') {
        fn = ext.wrapper;
        ext = ext.extension;
    }
    
    if (ext === 'post') {
        this.postFilters.push(fn);
    }
    else if (ext === 'pre') {
        this.preFilters.push(fn);
    }
    else if (fn) {
        this.extensions.push(ext);
        this.filters.push(function (body, file) {
            if (file.slice(-ext.length) === ext) {
                return fn.call(this, body, file);
            }
            else return body;
        });
    }
    else {
        this.filters.push(ext);
    }
    return this;
};

Wrap.prototype.readFile = function (file) {
    var self = this;
    
    var body = fs.readFileSync(file, 'utf8').replace(/^#![^\n]*\n/, '');
    
    self.filters.forEach(function (fn) {
        body = fn.call(self, body, file);
    });
    
    return body;
};

Wrap.prototype.alias = function (to, from) {
    this.aliases[to] = from;
    return this;
};

Wrap.prototype.addEntry = function (file) {
    var body = this.readFile(file);
    
    var required = detective.find(body);
    
    if (required.expressions.length) {
        console.error('Expressions in require() statements:');
        required.expressions.forEach(function (ex) {
            console.error('    require(' + ex + ')');
        });
    }
    
    var dir = path.dirname(path.resolve(process.cwd(), file));
    
    this.require(required.strings.map(function (r) {
        if (r.match(/^(\.\.?)?\//)) {
            return path.resolve(dir, r);
        }
        else return r;
    }));
    
    this.entries[file] = this.appends.length;
    this.append(wrappers.entry
        .replace(/\$__filename/g, function () {
            return JSON.stringify('/' + dir)
        })
        .replace(/\$__dirname/g, function () {
            return JSON.stringify('/')
        })
        .replace(/\$body/, function () {
            return body
        })
    );
    
    return this;
};

Wrap.prototype.bundle = function () {
    var self = this;
    
    for (var i = 0; i < self.prepends.length; i++) {
        var p = self.prepends[i];
        if (p === wrappers.prelude) {
            self.prepends[i] = p.replace(/\$extensions/, function () {
                return JSON.stringify(self.extensions);
            });
            break;
        }
    }
    
    this.preFilters.forEach((function (fn) {
        fn.call(this, this);
    }).bind(this));
    
    var src = []
        .concat(this.prepends)
        .concat(Object.keys(self.files).map(function (name) {
            return self.files[name].body;
        }))
        .concat(Object.keys(self.aliases).map(function (to) {
            var from = self.aliases[to];
            if (!to.match(/^(\.\.?)?\//)) {
                to = '/node_modules/' + to;
            }
            
            return wrappers.alias
                .replace(/\$from/, function () {
                    return JSON.stringify(from);
                })
                .replace(/\$to/, function () {
                    return JSON.stringify(to);
                })
            ;
        }))
        .concat(this.appends)
        .join('\n')
    ;
    
    this.postFilters.forEach((function (fn) {
        src = fn.call(this, src);
    }).bind(this));
    
    return src;
};

Wrap.prototype.wrap = function (target, body) {
    return wrappers.body
        .replace(/\$__filename/g, function () {
            return JSON.stringify(target)
        })
        .replace(/\$__dirname/g, function () {
            return JSON.stringify(path.dirname(target))
        })
        .replace(/\$body/, function () {
            return body.toString();
        })
    ;
};

Wrap.prototype.include = function (file, target, body) {
    this.files[file] = {
        body : this.wrap(target, body),
        target : target
    };
    return this;
};

function makeTarget (file, root) {
    if (isPrefixOf(root + '/', file)) {
        return path.normalize('/' + file.slice(root.length + 1));
    }
    else if (resolve.isCore(file) || !file.match(/^\//)) {
        return path.normalize(file);
    }
    else if (file.match(/\/node_modules\/.+/)) {
        return path.normalize(file.match(/(\/node_modules\/.+)/)[1]);
    }
    else {
        throw new Error('Can only load non-root modules'
            + ' in a node_modules directory for file: ' + file
        );
    }
}

Wrap.prototype.require = function (startFiles, withRoot) {
    var self = this;
    
    if (!startFiles) startFiles = []
    else if (!Array.isArray(startFiles)) {
        startFiles = [ startFiles ];
    }
    
    startFiles.forEach(function include (file) {
        var dir = process.cwd();
        
        if (typeof file === 'object') {
            Object.keys(file).forEach(function (key) {
                self.alias(key, file[key]);
                include(file[key]);
            });
            return;
        }
        
        if (resolve.isCore(file)) {
            var res = file;
        }
        else if (file.match(/^(\.\.?)?\//)) {
            var res = path.resolve(process.cwd(), file);
            var dir = path.dirname(res);
        }
        else {
            var res = file;
        }
        
        self.require_(res, { basedir : dir, root : withRoot || dir });
    });
    
    return self;
};

Wrap.prototype.require_ = function (mfile, opts) {
    var self = this;
    if (self.ignoring[mfile]) return;
    if (self.aliases[mfile]) return;
    
    var pkg = {};
    if (resolve.isCore(mfile)) {
        var file = path.resolve(__dirname, '../builtins/' + mfile + '.js');
        var target = mfile;
        var name = mfile;
        if (!path.existsSync(file)) {
            throw new Error('No wrapper for core module ' + mfile);
        }
    }
    else {
        try {
            var file = resolve.sync(mfile, {
                basedir : opts.basedir,
                extensions : self.extensions,
                packageFilter : function (pkg) {
                    var b = pkg.browserify;
                    if (b) {
                        if (typeof b === 'string') {
                            pkg.main = b;
                        }
                        else if (typeof b === 'object' && b.main) {
                            pkg.main = b.main;
                        }
                    }
                    return pkg
                }
            });
            var target = makeTarget(file, opts.root);
            var name = isPrefixOf(opts.root + '/', file) ? file : mfile;
            opts.basedir = path.dirname(file);
            
            var pkgfile = opts.basedir + '/package.json';
            if (!mfile.match(/^(\.\.?)?\//)) {
                try {
                    pkgfile = resolve.sync(mfile + '/package.json', {
                        basedir : opts.basedir
                    });
                }
                catch (err) {}
            }
            
            if (pkgfile && !self._checkedPackages[pkgfile]) {
                self._checkedPackages[pkgfile] = true;
                if (path.existsSync(pkgfile)) {
                    var pkgBody = fs.readFileSync(pkgfile, 'utf8');
                    try {
                        pkg = JSON.parse(pkgBody);
                    }
                    catch (err) {
                        // ignore broken package.jsons just like node
                    }
                    
                    self.include(pkgfile, makeTarget(pkgfile, opts.root), 
                        'module.exports = ' + JSON.stringify(pkg)
                    );
                }
            }
        }
        catch (err) {
            throw new Error('Cannot find module ' + JSON.stringify(mfile)
                + ' from directory ' + JSON.stringify(opts.basedir)
            );
        }
    }
    
    if (self.files[name]) return;
    
    var body = self.readFile(file);
    self.include(file, target, body);
    
    var required = detective.find(body);
    if (pkg.browserify && pkg.browserify.require) {
        required.strings = required.strings.concat(
            pkg.browserify.require
        );
    }
    
    if (required.expressions.length) {
        console.error('Expressions in require() statements:');
        required.expressions.forEach(function (ex) {
            console.error('    require(' + ex + ')');
        });
    }
    
    var keys = Object.keys(
        required.strings.reduce(function (acc, r) {
            acc[r] = true;
            return acc;
        }, {})
    );
    
    keys.forEach(function (f) {
        self.require_(f, { basedir : opts.basedir, root : opts.root })
    });
    
    return self;
};

function isPrefixOf (x, y) {
    return y.slice(0, x.length) === x;
}