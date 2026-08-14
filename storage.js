const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

function getClient(env) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
}

// buffer: Buffer, contentType: 'image/png' 등. 반환값: Meta가 바로 가져갈 수 있는 공개 URL.
async function uploadFile(env, buffer, contentType) {
  const ext = contentType.split('/')[1] || 'bin';
  const key = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const client = getClient(env);
  await client.send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
  return `${env.R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
}

// uploadFile()이 돌려준 공개 URL을 받아 R2에서 그 객체를 지운다. Threads가 발행 시점에
// 이미 미디어를 가져가 자체 저장해두므로, 발행이 확정된 지 한참 지난 뒤엔 우리 쪽 원본은
// 더 필요 없다 — worker.js의 정리 배치가 이 함수를 호출한다.
async function deleteFile(env, url) {
  const prefix = `${env.R2_PUBLIC_URL.replace(/\/$/, '')}/`;
  const key = url.startsWith(prefix) ? url.slice(prefix.length) : url;
  const client = getClient(env);
  await client.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
}

module.exports = { uploadFile, deleteFile };
