import { S3Client } from "@aws-sdk/client-s3";

const isDev = process.env.NODE_ENV !== "production";

export const s3Client = new S3Client({
  region: "us-east-1",
  ...(isDev && {
    endpoint: `http://${process.env.MINIO_ENDPOINT ?? "localhost"}:${process.env.MINIO_PORT ?? "9000"}`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.MINIO_ACCESS_KEY ?? "minioadmin",
      secretAccessKey: process.env.MINIO_SECRET_KEY ?? "minioadmin",
    },
  }),
});

export const BUCKET = process.env.MINIO_BUCKET ?? "uploads";
