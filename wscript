#
# NL OV Departures - Pebble build script
#
# This file is intentionally minimal: the Pebble SDK's own top-level
# wscript (bundled with pebble-tool / the rebble/pebble-sdk Docker image)
# does the heavy lifting. This project-level wscript just points it at
# our sources.
#
# See: https://developer.rebble.io/developer.pebble.com/guides/tools-and-resources/app-build-process/index.html

top = '.'
out = 'build'


def options(ctx):
    ctx.load('pebble_sdk')


def configure(ctx):
    ctx.load('pebble_sdk')


def build(ctx):
    ctx.load('pebble_sdk')

    build_worker = getattr(ctx.env, 'BUILD_WORKER', False)
    binaries = []

    for platform in ctx.env.TARGET_PLATFORMS:
        ctx.set_env(ctx.all_envs[platform])
        ctx.set_group(ctx.env.PLATFORM_NAME)
        app_elf = '{}/pebble-app.elf'.format(ctx.env.BUILD_DIR)
        ctx.pbl_program(source=ctx.path.ant_glob('src/c/**/*.c'),
                         target=app_elf)

        if build_worker:
            worker_elf = '{}/pebble-worker.elf'.format(ctx.env.BUILD_DIR)
            binaries.append({'platform': platform,
                              'app_elf': app_elf,
                              'worker_elf': worker_elf})
        else:
            binaries.append({'platform': platform, 'app_elf': app_elf})

    ctx.set_group('bundle')
    ctx.pbl_bundle(binaries=binaries,
                    js=ctx.path.ant_glob('src/pkjs/**/*.js') +
                       ctx.path.ant_glob('src/pkjs/**/*.json'))
