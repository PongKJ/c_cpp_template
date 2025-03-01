import child_process from "child_process";
import process from "process";

export function refreshEnv(script_path: string, error_message_pattern?: RegExp) {
  let old_environment
  let script_output
  let new_environment
  if (process.platform == "win32") {
    const cmd_output_string = child_process
      .execSync(`set && cls && ${script_path} && cls && set`, { shell: "cmd" })
      .toString();
    const cmd_output_parts = cmd_output_string.split("\f");
    old_environment = cmd_output_parts[0].split("\r\n");
    script_output = cmd_output_parts[1].split("\r\n");
    new_environment = cmd_output_parts[2].split("\r\n");
  } else if (process.platform == "linux") {
    // 参照 ~/.bashrc 中的代码段
    //``` # If not running interactively, don't do anything
    //    [[ $- != *i* ]] && return ```
    // 为了避免非交互式shell执行脚本时，直接退出而无法设置环境变量，需要显示制定交互式'-i'
    const cmd_output_string = child_process
      .execSync(`bash -i -c 'env && echo \f && ${script_path} && echo \f && env'`, { shell: "bash" })
      .toString();
    const cmd_output_parts = cmd_output_string.split("\f\n");
    console.log(cmd_output_parts)
    old_environment = cmd_output_parts[0].split("\n").filter(item => item.length > 0);
    script_output = cmd_output_parts[1].split("\n").filter(item => item.length > 0);
    new_environment = cmd_output_parts[2].split("\n").filter(item => item.length > 0);
  }

  // If vsvars.bat is given an incorrect command line, it will print out
  // an error and *still* exit successfully. Parse out errors from output
  // which don't look like environment variables, and fail if appropriate.
  if (error_message_pattern !== undefined) {
    const error_messages = script_output.filter((line) => {
      if (line.match(error_message_pattern)) {
        return true;
      }
      return false;
    });
    if (error_messages.length > 0) {
      throw new Error(
        "invalid parameters" + "\r\n" + error_messages.join("\r\n")
      );
    }
  }
  // Convert old environment lines into a dictionary for easier lookup.
  let old_env_vars = {};
  for (let string of old_environment) {
    const [name, value] = string.split("=");
    old_env_vars[name] = value;
  }

  // Now look at the new environment and export everything that changed.
  // These are the variables set by vsvars.bat. Also export everything
  // that was not there during the first sweep: those are new variables.
  for (let string of new_environment) {
    // vsvars.bat likes to print some fluff at the beginning.
    // Skip lines that don't look like environment variables.
    if (!string.includes("=")) {
      continue;
    }
    let [name, new_value] = string.split("=");
    let old_value = old_env_vars[name];
    // For new variables "old_value === undefined".
    if (new_value !== old_value) {
      // Special case for a bunch of PATH-like variables: vcvarsall.bat
      // just prepends its stuff without checking if its already there.
      // This makes repeated invocations of this action fail after some
      // point, when the environment variable overflows. Avoid that.
      if (isPathVariable(name)) {
        new_value = filterPathValue(new_value);
      }
      console.log(`export ${name}=${new_value}`);
      process.env[name] = new_value;
    }
  }
}

function filterPathValue(path) {
  function unique(value, index, self) {
    return self.indexOf(value) === index;
  }
  let paths: string[] = [];
  if (process.platform == 'win32') {
    paths = path.split(";");
    // Remove duplicates by keeping the first occurance and preserving order.
    // This keeps path shadowing working as intended.
    return paths.filter(unique).join(";");
  }
  else if (process.platform == 'linux') {
    paths = path.split(":");
    return paths.filter(unique).join(":");
  }
}

function isPathVariable(name) {
  // TODO: Add more variables to the list.
  const pathLikeVariables = ["PATH", "INCLUDE", "LIB", "LIBPATH"];
  return pathLikeVariables.indexOf(name.toUpperCase()) != -1;
}

refreshEnv("source ~/.bashrc")
