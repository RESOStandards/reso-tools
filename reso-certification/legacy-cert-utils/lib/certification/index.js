'use strict';

const { runDDTests, DEFAULT_LIMIT } = require('./data-dictionary');
const { runUpiTests } = require('./upi');

module.exports = {
  DEFAULT_LIMIT,
  runDDTests,
  runUpiTests
};
