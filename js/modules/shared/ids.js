"use strict";

/**
 * Not one of the four originally planned shared files, but "ID
 * generation" was explicitly called out as a likely candidate, and
 * genId() is used by Fuel, Training, and Protocols with no natural
 * home in formatting/dates/dom/validation.
 */
(function (global) {
  function genId(prefix) {
    return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  global.BioCommandShared = global.BioCommandShared || {};
  global.BioCommandShared.ids = { genId };
})(window);
