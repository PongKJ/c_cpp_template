import { throws } from 'assert'
import { PathOrFileDescriptor } from 'fs'
import { usePowerShell } from 'zx'
import 'zx/globals'
import { MSVCInstallDir } from './scripts/consts.mjs'
import { findCmdsInEnv, refreshEnv } from './scripts/envHelper.mts'
import { setupMSVCDevCmd } from './scripts/setupMSVCDev.mts'


const cachePath = '.project_cache.json'
const presetsFilePath = 'CMakePresets.json'
let script_postfix = ''

const $$ = $({ nothrow: true })

if (process.platform === 'win32') {
  usePowerShell()
  script_postfix = 'bat'
}

if (process.platform === 'linux') {
  script_postfix = 'sh'
}

function jsonParse(json: PathOrFileDescriptor) {
  try {
    let content = fs.readFileSync(json, 'utf8')
    return JSON.parse(content)
  } catch (e) {
    console.error(chalk.redBright('error:', e))
    throws(e)
  }
}

interface CmakeOptionsContext {
  packagingMaintainerMode: boolean,
  warningsAsErrors: boolean,
  enableClangTidy: boolean,
  enableCppcheck: boolean,
  enableSanitizerLeak: boolean,
  enableSanitizerUndefined: boolean,
  enableSanitizerThread: boolean,
  enableSanitizerMemory: boolean,
  enableSanitizerAddress: boolean,
  enableUnityBuild: boolean,
  enablePch: boolean,
  enableCache: boolean,
  enableIpo: boolean,
  enableUserLinker: boolean,
  enableCoverage: boolean,
  buildFuzzTests: boolean,
  enableHardening: boolean,
  enableGlobalHardening: boolean,
  gitSha: string,
}

interface CmakePresetContext {
  presetsFilePath: PathOrFileDescriptor,
  selectedPreset: string,
}

enum TargetType {
  Build,
  Launch,
  Test,
}

interface TargetContext {
  target: string[]
  args: string[]
}

interface SetupContext {
  cmakePreset: CmakePresetContext
}

interface ProjectContext {
  projectName: string
  // decided by the preset
  cmakePreset: string
  sourceDir: string
  binaryDir: string
  installDir: string
  buildType: string
  // decided by the user
  buildTarget: string[]
  launchTarget: string[]
  launchArgs: string[]
  testArgs: string[]
}

interface State {
  // last time the project was configured with a temporary contex, need to reload from cache
  needReconfig: boolean
}

class ProjectContext {
  cachePath: PathOrFileDescriptor
  projectContext: ProjectContext
  cmakeOptionsContext: CmakeOptionsContext
  state: State

  setTargetContext(type: TargetType, context: TargetContext) {
    switch (type) {
      case TargetType.Build:
        this.projectContext.buildTarget = context.target
        break
      case TargetType.Launch:
        this.projectContext.launchTarget = context.target
        this.projectContext.launchArgs = context.args
        break
      case TargetType.Test:
        this.projectContext.testArgs = context.args
        break
    }
  }

  constructor(setup?: SetupContext) {
    this.cachePath = cachePath
    if (setup) {
      this.setup(setup.cmakePreset)
    }
    else
      try {
        const parsedCache = jsonParse(this.cachePath)
        this.projectContext = parsedCache.projectContext
        this.cmakeOptionsContext = parsedCache.cmakeOptionsContext
        this.state = parsedCache.state
      } catch (e) {
        console.error(`Unable to parse config from json file:${{ e }}, possibly forgot to run setup first?`)
      }
  }

  // NOTE: Change follow to set a default value for each config
  private setup = function (preset: CmakePresetContext) {
    const presets = jsonParse(preset.presetsFilePath)
    // these variables is used by 'eval' command bellow
    const sourceDir = process.cwd()
    const presetName = preset.selectedPreset
    try {
      const env = dotenv.parse(fs.readFileSync('./.github/constants.env'))
      this.projectContext = {
        cmakePreset: preset.selectedPreset,
        sourceDir: process.cwd(),
        buildTarget: ['all'],
        launchTarget: [],
        launchArgs: [],
        testArgs: [],
        projectName: env.PROJECT_NAME,
        binaryDir: presets.configurePresets[0].binaryDir.replace(/\$\{(.*?)\}/g, (_, p1) => eval(p1)),
        installDir: presets.configurePresets[0].installDir.replace(/\$\{(.*?)\}/g, (_, p1) => eval(p1)),
        buildType: presets.configurePresets.find(item => item.name == preset.selectedPreset).cacheVariables.CMAKE_BUILD_TYPE
      }
    } catch (e) {
      console.error(chalk.redBright('Error: Failed to parser cmake presets, please check the exists of this preset'))
      process.exit(1)
    }
    this.cmakeOptionsContext = {
      packagingMaintainerMode: true,
      warningsAsErrors: false,
      enableClangTidy: false,
      enableCppcheck: false,
      enableSanitizerLeak: true,
      enableSanitizerUndefined: true,
      enableSanitizerThread: true,
      enableSanitizerMemory: true,
      enableSanitizerAddress: true,
      enableUnityBuild: false,
      enablePch: false,
      enableCache: false,
      enableIpo: false,
      enableUserLinker: false,
      enableCoverage: false,
      buildFuzzTests: false,
      enableHardening: false,
      enableGlobalHardening: false,
      gitSha: process.env.GITHUB_SHA ? process.env.GITHUB_SHA : 'unkown'
    }
    this.state = {
      needReconfig: true
    }
  }

  save2File = function () {
    fs.writeFileSync(this.cachePath, JSON.stringify({ projectContext: this.projectContext, cmakeOptionsContext: this.cmakeOptionsContext, state: this.state }, null, 2))
  }
}

class Excutor {
  context: ProjectContext

  constructor(context: ProjectContext) {
    this.context = context
  }

  private refreshEnvFromScript = function (script: string) {
    if (process.platform === 'win32') {
      refreshEnv(script)
    }
    else if (process.platform === 'linux') {
      refreshEnv(`source ${script}`)
    }
  }

  clean = async function () {
    if (fs.existsSync(this.context.projectContext.binaryDir)) {
      await fs.remove(this.context.projectContext.binaryDir)
    }
  }

  private camelToSnake = function (str: string) {
    return str.replace(/[A-Z]/g, letter => `_${letter}`)
  }
  private cmakeOptionsTransform = function () {
    let cmakeOptions: string[] = []
    for (const [key, value] of Object.entries(this.context.cmakeOptionsContext)) {
      if (typeof value === 'boolean')
        cmakeOptions.push(`-D${this.context.projectContext.projectName}_${this.camelToSnake(key).toUpperCase()}:BOOL=${value ? 'ON' : 'OFF'}`)
      else
        cmakeOptions.push(`-D${this.camelToSnake(key).toUpperCase()}:STRING=${value}`)
    }
    return cmakeOptions
  }

  cmakeConfigure = async function () {
    this.context.state.needReconfig = false
    if (this.context.projectContext.cmakePreset.includes('msvc')) {
      setupMSVCDevCmd(
        "x64",
        MSVCInstallDir,
        undefined,
        undefined,
        false,
        false,
        undefined
      );
      const cmakeConfigreCommand = `"cmake -S . --preset=${this.context.projectContext.cmakePreset} ${this.cmakeOptionsTransform().join(' ')}"`
      await $$`powershell -Command ${cmakeConfigreCommand}`.pipe(process.stderr)
      const newItemCommand = `"New-Item -ItemType SymbolicLink -Path ${this.context.projectContext.sourceDir}/compile_commands.json -Target ${this.context.binaryDir}/compile_commands.json"`
      await $$`powershell -Command ${newItemCommand}`.pipe(process.stderr)
    } else {
      await $$`cmake -S . --preset=${this.context.projectContext.cmakePreset} ${this.cmakeOptionsTransform()}`.pipe(process.stderr)
      await $$`ln -sfr ${this.context.projectContext.binaryDir}/compile_commands.json ${this.context.projectContext.sourceDir}/compile_commands.json `.pipe(process.stderr)
    }
  }

  cmakeBuild = async function () {
    if (this.context.state.needReconfig) {
      await this.cmakeConfigure()
    }
    this.refreshEnvFromScript(`${this.context.projectContext.binaryDir}/conan/build/${this.context.projectContext.buildType}/generators/conanbuild.${script_postfix}`)
    this.refreshEnvFromScript(`${this.context.projectContext.binaryDir}/conan/build/${this.context.projectContext.buildType}/generators/conanrun.${script_postfix}`)
    if (this.context.projectContext.cmakePreset.includes('msvc')) {
      setupMSVCDevCmd(
        "x64",
        MSVCInstallDir,
        undefined,
        undefined,
        false,
        false,
        undefined
      );
      const cmakeBuildCommand = `"cmake --build ${this.context.projectContext.binaryDir} --target ${this.context.projectContext.buildTarget.join(' ')}"`
      await $$`powershell -Command ${cmakeBuildCommand}`.pipe(process.stderr)
    } else {
      const cmd = `cmake --build ${this.context.projectContext.binaryDir} --target ${this.context.projectContext.buildTarget.join(' ')}`.trim()
      await $$`bash -c ${cmd}`.pipe(process.stderr)
    }
  }

  runTarget = async function () {
    this.context.projectContext.buildTarget = this.context.projectContext.launchTarget
    await this.cmakeBuild()
    this.refreshEnvFromScript(`${this.context.projectContext.binaryDir}/conan/build/${this.context.projectContext.buildType}/generators/conanrun.${script_postfix}`)
    if (process.platform === 'win32') {
      // WARN: Only run the first target
      const runTargetCommand = `"${this.context.projectContext.binaryDir}/bin/${this.context.projectContext.launchTarget[0]}.exe ${this.context.projectContext.launchArgs.join(' ')}"`.trim()
      await $$({ stdio: ['inherit', 'pipe', 'pipe'] })`powershell -Command ${runTargetCommand}`.pipe(process.stderr)
    } else {
      const cmd = `${this.context.projectContext.binaryDir}/bin/${this.context.projectContext.launchTarget[0]} ${this.context.projectContext.launchArgs.join(' ')}`.trim()
      await $$({ stdio: ['inherit', 'pipe', 'pipe'] })`bash -c ${cmd}`.pipe(process.stderr)
    }
  }
  runTest = async function () {
    await this.cmakeBuild()
    this.refreshEnvFromScript(`${this.context.projectContext.binaryDir}/conan/build/${this.context.projectContext.buildType}/generators/conanrun.${script_postfix}`)
    if (process.platform === 'win32') {
      const runTestCommand = `"ctest ${this.context.projectContext.testArgs.join(' ')}"`
      await $$`powershell -Command ${runTestCommand}`.pipe(process.stderr)
    } else {
      await $$`ctest --preset ${this.context.projectContext.cmakePreset} ${this.context.projectContext.testArgs.join(' ')}`.pipe(process.stderr)
    }
  }

  runCov = async function () {
    if (this.context.cmakeOptionsContext.enableCoverage == false) {
      console.log(chalk.yellowBright('Coverage is not enabled, trying to enable it and build again...'))
      this.context.cmakeOptionsContext.enableCoverage = true
      await this.cmakeConfigure()
      this.context.cmakeOptionsContext.enableCoverage = false
    }
    await this.cmakeBuild()
    this.refreshEnvFromScript(`${this.context.projectContext.binaryDir}/conan/build/${this.context.projectContext.buildType}/generators/conanrun.${script_postfix}`)
    if (process.platform === 'win32') {
      const runTestCommand = `"OpenCppCoverage.exe --working_dir ${this.context.projectContext.binaryDir} --export_type cobertura:coverage.xml --cover_children -- ctest ${this.context.projectContext.testArgs.join(' ')}"`
      await $$`powershell -Command ${runTestCommand}`.pipe(process.stderr)
    } else {
      await $$`ctest --preset ${this.context.projectContext.cmakePreset} ${this.context.projectContext.testArgs.join(' ')}`.pipe(process.stderr)
      await $$`gcovr --delete --root . --print-summary --xml-pretty --xml ${this.context.projectContext.binaryDir}/coverage.xml . --gcov-executable gcov`.pipe(process.stderr)
    }
  }

  install = async function () {
    await this.cmakeBuild()
    if (process.platform === 'win32') {
      const cpackCommand = `"cmake --install ${this.context.projectContext.binaryDir}"`
      await $$`powershell -Command ${cpackCommand}`.pipe(process.stderr)
    } else {
      await $$`cmake --install ${this.context.projectContext.binaryDir}`.pipe(process.stderr)
    }
  }

  cpack = async function () {
    await this.cmakeBuild()
    if (process.platform === 'win32') {
      const cpackCommand = `"cd ${this.context.projectContext.binaryDir};cpack"`
      await $$`powershell -Command ${cpackCommand}`.pipe(process.stderr)
    } else {
      await $$`cd ${this.context.projectContext.binaryDir} && cpack`.pipe(process.stderr)
    }
  }
}

function showHelp() {
  console.log(chalk.green(' This script is used to run target flexible'))
  console.log(chalk.green(' usage: project.mjs <action> [target] [-- args]'))
  console.log(chalk.green(' for example:\n'))
  console.log(chalk.green(' Geting help'))
  console.log(chalk.green(' tsx project.mts                                     ---show help'))
  console.log(chalk.green(' tsx project.mts -h                                  ---show help'))
  console.log(chalk.green(' tsx project.mts --help                              ---show help'))
  console.log("\n")
  console.log(chalk.green(' Setup the project(select a cmake preset, parse and store it)'))
  console.log(chalk.green(' tsx project.mts setup  some_preset                  ---setup the project with specified preset'))
  console.log("\n")
  console.log(chalk.green(' Clean the project'))
  console.log(chalk.green(' tsx project.mts clean                               ---clean project'))
  console.log("\n")
  console.log(chalk.green(' Cmake configure'))
  console.log(chalk.green(' tsx project.mts config                              ---run cmake configure'))
  console.log("\n")
  console.log(chalk.green(' Build the project'))
  console.log(chalk.green(' tsx project.mts build                               ---build all targets'))
  console.log(chalk.green(' tsx project.mts build [target_name]                 ---build the target [target_name]'))
  console.log("\n")
  console.log(chalk.green(' Run the target'))
  console.log(chalk.green(' tsx project.mts run [target_name]                   ---run the target [target]'))
  console.log(chalk.green(' tsx project.mts run [target_name] [-- target_args]  ---run the target [target_name] with target_args'))
  console.log("\n")
  console.log(chalk.green(' Test the project'))
  console.log(chalk.green(' tsx project.mts test                                ---run all tests'))
  console.log(chalk.green(' tsx project.mts test [test_name]                    ---run the test [test_name]'))
  console.log("\n")
  console.log(chalk.green(' Pack the project'))
  console.log(chalk.green(' tsx project.mts pack                                ---pack the project'))
  console.log("\n")
  console.log(chalk.hex('0xa9cc00')('Usage: tsx project.mts <action> [target] [-- args]'))
  console.log(chalk.hex('0xa9cc00')('action: config | clean | build | run | test | install | pack'))
  console.log(chalk.hex('0xa9cc00')('target: the target to execute the action'))
  console.log(chalk.hex('0xa9cc00')('args: the arguments to pass to the target'))
}


async function main() {
  if (argv._.length == 0 || argv.h || argv.help) {
    showHelp()
    process.exit(0)
  }
  const myArgv = minimist(process.argv.slice(2), {
    ['--']: true
  })
  console.log(chalk.blue("Script args: ", myArgv._.join(' ')))
  if (myArgv['--'] !== undefined) {
    console.log(chalk.blue("Target args: ", myArgv['--'].join(' ')))
  }

  // To avoid user not reload the ternimal after install tools,refresh the env
  let cmdsNotFound = findCmdsInEnv(['cmake', 'conan', 'ninja', 'ctest']) // 'ccache'
  if (cmdsNotFound.length > 0) {
    console.log(chalk.redBright(`Some commands not found in path:${cmdsNotFound} ,Tring reload the environment...`))
    if (process.platform === 'win32') {
      refreshEnv('refreshenv')
    }
    else if (process.platform === 'linux') {
      refreshEnv('source ~/.profile')
    }
  }

  let targetContext = {
    target: new Array<string>(),
    args: new Array<string>()
  }

  if (myArgv._[0] == 'setup') {
    console.log(chalk.greenBright('Running setup...'))
    if (myArgv._.length < 2) {
      console.error(chalk.redBright('Please specify a preset to setup'))
      process.exit(1)
    }
    const setup_preset: CmakePresetContext = {
      presetsFilePath,
      selectedPreset: myArgv._[1],
    }
    let context = new ProjectContext({ cmakePreset: setup_preset })
    // remember to save the context to file
    context.save2File()
    return
  }

  const context = new ProjectContext()
  const excutor = new Excutor(context)

  switch (myArgv._[0]) {
    case 'clean':
      console.log(chalk.greenBright('Cleaning project...'))
      await excutor.clean()
      break
    case 'config':
      console.log(chalk.greenBright('Configuring project...'))
      await excutor.clean()
      await excutor.cmakeConfigure()
      break
    case 'build':
      targetContext.target = context.projectContext.buildTarget
      if (myArgv._.length > 1) {
        console.log(chalk.greenBright('Building target:', myArgv._.slice(1).join(',')))
        targetContext.target = myArgv._.slice(1)
      } else {
        console.log(chalk.greenBright("Building all targets"))
        targetContext.target = ['all']
      }
      context.setTargetContext(TargetType.Build, targetContext)
      await excutor.cmakeBuild()
      break
    case 'run':
      targetContext.target = context.projectContext.launchTarget
      targetContext.args = context.projectContext.launchArgs
      if (myArgv._.length > 1) {
        console.log(chalk.greenBright('Runing target:', myArgv._[1]))
        targetContext.target = myArgv._.slice(1)
      }
      else if (targetContext.target.length !== 0) {
        console.log(chalk.greenBright('Runing target:', targetContext.target.join(' ')))
      }
      else {
        console.error(chalk.redBright("Please specify a target to run"))
        return
      }
      if (myArgv['--'] && myArgv['--'].length > 0) {
        console.log(chalk.greenBright('args:', myArgv['--'].join(' ')))
        targetContext.args = myArgv['--']
      }
      context.setTargetContext(TargetType.Launch, targetContext)
      await excutor.runTarget()
      break
    case 'test':
      targetContext.args = context.projectContext.testArgs
      console.log(chalk.greenBright('Testing project...'))
      if (myArgv['--'] && myArgv['--'].length > 0) {
        console.log(chalk.greenBright('args:', myArgv['--'].join(' ')))
        targetContext.args = myArgv['--']
        context.setTargetContext(TargetType.Test, targetContext)
      }
      await excutor.runTest()
      break
    case 'cov':
      targetContext.args = context.projectContext.testArgs
      console.log(chalk.greenBright('Getting Coverage of this project...'))
      if (myArgv['--'] && myArgv['--'].length > 0) {
        targetContext.args = myArgv['--']
        context.setTargetContext(TargetType.Test, targetContext)
      }
      await excutor.runCov()
      break
    case 'install':
      console.log(chalk.greenBright('Installing project...'))
      await excutor.install()
      break
    case 'pack':
      console.log(chalk.greenBright('Packing project...'))
      await excutor.cpack()
      break
    default:
      showHelp()
      break
  }
  // remember to save the context to file
  context.save2File()
}

main()
