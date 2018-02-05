import {parseString} from 'xml2js';
import DroneCommand from './DroneCommand';
import Logger from 'winston';
import InvalidCommandError from './InvalidCommandError';


const _fileCache = {};
const _commandCache = {};

/**
 * Command parser used for looking up commands in the xml definition
 */
export default class CommandParser {
  /**
   * Get an xml file and convert it to json
   * @param {string} name - project name
   * @returns {Object}
   * @private
   */
  _getXml(name) {
    const file = CommandParser._fileMapping[name];

    if (typeof file === 'undefined') {
      throw new Error(`Xml file ${name} could not be found`);
    }

    if (typeof _fileCache[name] === 'undefined') {
      _fileCache[name] = null;

      parseString(file, {async: false}, (e, result) => {
        _fileCache[name] = result;
      });

      return this._getXml(name);
    } else if (_fileCache[name] === null) {
      // Fuck javascript async hipster shit
      return this._getXml(name);
    }

    return _fileCache[name];
  }

  /**
   * Used for file loading/lookup
   * @returns {{minidrone: string, common: string}} - xml files with contents
   * @private
   */
  static get _fileMapping() {
    return {
      minidrone: require('arsdk-xml/xml/minidrone.xml'),
      common: require('arsdk-xml/xml/common.xml'),
    };
  }

  /**
   * Get a list of available files
   * @returns {string[]} - Available files
   * @private
   */
  static get _files() {
    return Object.keys(CommandParser._fileMapping);
  }

  /**
   * Get a command based on it's path in the xml definition
   * @param {string} projectName - The xml file name (project name)
   * @param {string} className - The command class name
   * @param {string} commandName - The command name
   * @param {Object?} commandArguments - Optional command arguments
   * @returns {DroneCommand} - Target command
   * @throws InvalidCommandError
   * @see {@link https://github.com/Parrot-Developers/arsdk-xml/blob/master/xml/}
   * @example
   * const parser = new CommandParser();
   * const backFlip = parser.getCommand('minidrone', 'Animations', 'Flip', {direction: 'back'});
   */
  getCommand(projectName, className, commandName, commandArguments = {}) {
    const cacheToken = [
      projectName, className,
      commandName,
    ].join('-');

    if (typeof _commandCache[cacheToken] === 'undefined') {
      const project = this._getXml(projectName).project;

      this._assertElementExists(project, 'project', projectName);

      const context = [projectName];

      const targetClass = project.class.find(v => v.$.name === className);

      this._assertElementExists(targetClass, 'class', className);

      context.push(className);

      const targetCommand = targetClass.cmd.find(v => v.$.name === commandName);

      this._assertElementExists(targetCommand, 'command', commandName);

      const result = new DroneCommand(project, targetClass, targetCommand);

      _commandCache[cacheToken] = result;

      if (result.deprecated) {
        Logger.warn(`${result.toString()} has been deprecated`);
      }
    }

    const target = _commandCache[cacheToken].clone();

    for (const arg of Object.keys(commandArguments)) {
      if (target.hasArgument(arg)) {
        target[arg] = commandArguments[arg];
      }
    }

    return target;
  }

  _getCommandFromBuffer(buffer) {
    const projectId = buffer.readUInt8(0);
    const classId = buffer.readUInt8(1);
    const commandId = buffer.readUInt8(2);

    const cacheToken = [projectId, classId, commandId].join('-');

    // Build command if needed
    if (typeof _commandCache[cacheToken] === 'undefined') {
      // Find project
      const project = CommandParser._files
        .map(x => this._getXml(x).project)
        .find(x => Number(x.$.id) === projectId);

      this._assertElementExists(project, 'project', projectId);

      // find class
      const targetClass = project.class.find(x => Number(x.$.id) === classId);

      const context = [project.$.name];

      this._assertElementExists(targetClass, 'class', classId, context);

      // find command
      const targetCommand = targetClass.cmd.find(x => Number(x.$.id) === commandId);

      context.push(targetClass.$.name);

      this._assertElementExists(targetCommand, 'command', commandId, context);

      // Build command and store it
      _commandCache[cacheToken] = new DroneCommand(project, targetClass, targetCommand);
    }

    return _commandCache[cacheToken].clone();
  }

  /**
   * Parse the input buffer and get the correct command with parameters
   * Used internally to parse sensor data
   * @param {Buffer} buffer - The command buffer without the first two bytes
   * @returns {DroneCommand} - Parsed drone command
   * @throws InvalidCommandError
   * @throws TypeError
   */
  parseBuffer(buffer) {
    const command = this._getCommandFromBuffer(buffer);

    let bufferOffset = 3;

    for (const arg of command.arguments) {
      let valueSize = arg.getValueSize();
      let value = 0;

      switch (arg.type) {
        case 'u8':
        case 'u16':
        case 'u32':
        case 'u64':
          value = buffer.readUIntLE(bufferOffset, valueSize);
          break;
        case 'i8':
        case 'i16':
        case 'i32':
        case 'i64':
          value = buffer.readIntLE(bufferOffset, valueSize);
          break;
        case 'enum':
          // @todo figure out why I have to do this
          value = buffer.readIntLE(bufferOffset + 1, valueSize - 1);
          break;
        case 'string':
          value = '';
          let c = ''; // Last character

          for (valueSize = 0; valueSize < buffer.length && c !== '\0'; valueSize++) {
            c = String.fromCharCode(buffer[bufferOffset]);

            value += c;
          }
          break;
        case 'float':
          value = buffer.readFloatBE(bufferOffset);
          break;
        case 'double':
          value = buffer.readDoubleLE(bufferOffset);
          break;
        default:
          throw new TypeError(`Can't parse buffer: unknown data type "${arg.type}" for argument "${arg.name}" in ${command.getToken()}`);
      }

      arg.value = value;

      bufferOffset += valueSize;
    }

    return command;
  }

  /**
   * Warn up the parser by pre-fetching the xml files
   */
  warmup() {
    CommandParser._files.forEach(file => this._getXml(file));
  }

  /**
   * helper method
   * @private
   * @throws InvalidCommandError
   */
  _assertElementExists(value, type, target, context = []) {
    if (typeof value === 'undefined') {
      throw new InvalidCommandError(value, type, target, context);
    }
  }
}