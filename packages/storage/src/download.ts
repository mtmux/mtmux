import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client, BUCKET } from "./client";

interface PresignedDownloadOptions {
  key: string;
  expiresIn?: number;
}

export async function getPresignedDownloadUrl({
  key,
  expiresIn = 3600,
}: PresignedDownloadOptions): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
}
