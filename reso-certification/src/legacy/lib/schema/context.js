/**
 * The object created from this function will close over the states relevant to
 * the currently running validation process. The objective here is to directly
 * use this state from functions that need it. For eg. the ajv custom validator
 * is called internally by ajv and we have now way of passing this state as param
 * to the validator.
 *
 * The methods on this object are purely getters/setters and are not supposed to
 * modify any state that is passed to them.
 */
const createValidationContext = () => {
  let activeResource = '';
  let isRCF = false;
  let ddVersion = '';
  let schema = null;
  /**
   * @type {'SINGLE'|'MULTI'|null}
   */
  let payloadType = null;
  let validationConfig = null;
  let disableKeys = false;
  return {
    getActiveResource: () => activeResource,
    setActiveResource: resource => {
      activeResource = resource;
    },
    setRCF: rcf => {
      isRCF = rcf;
    },
    isRCF: () => isRCF,
    getVersion: () => ddVersion,
    setVersion: version => {
      ddVersion = version;
    },
    getSchema: () => schema,
    setSchema: s => {
      schema = s;
    },
    getPayloadType: () => payloadType,
    /**
     *
     * @param {'SINGLE'|'MULTI'|null} type
     */
    setPayloadType: type => {
      payloadType = type;
    },
    getValidationConfig: () => validationConfig,
    setValidationConfig: config => {
      validationConfig = config;
    },
    keysDisabled: () => disableKeys,
    setKeysDisabled: isDisabled => {
      disableKeys = isDisabled;
    },
    reset: () => {
      activeResource = '';
      isRCF = false;
      ddVersion = '';
      schema = null;
      payloadType = null;
      validationConfig = null;
    }
  };
};

const validationContext = createValidationContext();

module.exports = {
  validationContext
};
