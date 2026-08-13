const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
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

module.exports = { uploadFile };
