module.exports = {
  modulePathIgnorePatterns: ['/bin/'],
  testPathIgnorePatterns: ['/node_modules/', '/bin/', '/functions/'],
  coverageProvider: 'v8',
  coverageReporters: ['text', 'lcov'],
  restoreMocks: true,
};
