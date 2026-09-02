export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // 中文正文常见，放宽长度上限
    'body-max-line-length': [1, 'always', 120],
    'subject-case': [0]
  }
};
