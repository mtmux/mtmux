import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client, BUCKET } from "./client";

interface PresignedUploadOptions {
  key: string;
  contentType: string;
  expiresIn?: number;
}

export async function getPresignedUploadUrl({
  key,
  contentType,
  expiresIn = 3600,
}: PresignedUploadOptions): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
}
