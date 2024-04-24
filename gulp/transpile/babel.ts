import { join } from 'path'

import gulp from 'gulp'
import babel from 'gulp-babel'
import { createGulpEsbuild } from 'gulp-esbuild'
import rename from 'gulp-rename'
import sourcemaps from 'gulp-sourcemaps'

import { BUILD_DIR, DIST_DIR, SRC_DIR } from '../constants'

const esbuild = createGulpEsbuild({
  incremental: true,
  pipe: true,
})

type Variant = 'cjs' | 'esm'

function changeExtname(val: string) {
  return val.replace(/\.js$/, '.cjs')
}

function transpileBabel(variant: Variant) {
  const task = () =>
    gulp
      .src([join(SRC_DIR, '**', '*.ts'), '!' + join(SRC_DIR, '**', '*.d.ts')])
      .pipe(sourcemaps.init())
      .pipe(babel({ envName: variant.toUpperCase() }))
      .pipe(
        rename((path) => {
          if (variant === 'esm') return path
          if (path.extname === '.js') return { ...path, extname: '.cjs' }
          return { ...path, basename: changeExtname(path.basename) } // .map
        })
      )
      .pipe(
        // gulp-sourcemaps patched to support .cjs extension
        sourcemaps.write('.', {
          sourceMappingURL:
            variant !== 'cjs' ? (file) => `${changeExtname(file.relative)}.map` : undefined,
          mapFile: variant === 'cjs' ? changeExtname : undefined,
          sourceRoot: '../../src',
        })
      )
      .pipe(gulp.dest(join(DIST_DIR, variant)))
  task.displayName = `transpile:babel:${variant}`
  return task
}

function transpileModuleLoader(variant: Variant) {
  const task = () =>
    gulp
      .src(join(BUILD_DIR, `MediaInfoModule.${variant}.js`))
      .pipe(
        esbuild({
          outfile: `MediaInfoModule${variant === 'cjs' ? '.cjs' : '.js'}`,
          minify: true,
          platform: 'node',
          target: 'node7',
        })
      )
      .pipe(gulp.dest(join(DIST_DIR, variant)))
  task.displayName = `transpile:esbuild:loader-${variant}`
  return task
}

const esmTask = gulp.parallel([transpileBabel('esm'), transpileModuleLoader('esm')])
const cjsTask = gulp.parallel([transpileBabel('cjs'), transpileModuleLoader('cjs')])

const babelTask = gulp.parallel([esmTask, cjsTask])
babelTask.displayName = 'transpile:babel'
babelTask.description = 'Transpile Node.js'

export default babelTask
