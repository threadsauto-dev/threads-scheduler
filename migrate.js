const { migrate, pool } = require('./db');

migrate()
  .then(() => {
    console.log('마이그레이션 완료 (channels, scheduled_posts 테이블 준비됨)');
    return pool.end();
  })
  .catch((e) => {
    console.error('마이그레이션 실패:', e.message);
    process.exit(1);
  });
