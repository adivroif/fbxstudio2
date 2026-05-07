
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET_NAME;

async function listFiles() {
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    console.log("Missing R2 configuration");
    return;
  }

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  const folders = ["files", "images"];
  const modelName = "Axe";
  
  try {
    for (const folder of folders) {
      const prefix = `${folder}/`;
      let allFiles = [];
      let isTruncated = true;
      let continuationToken = undefined;

      while (isTruncated) {
        const command = new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken
        });

        const response = await client.send(command);
        allFiles = allFiles.concat(response.Contents || []);
        isTruncated = response.IsTruncated || false;
        continuationToken = response.NextContinuationToken;
      }

      const modelNameLower = modelName.toLowerCase();
      const filtered = allFiles.filter(obj => (obj.Key || "").toLowerCase().includes(modelNameLower));
      
      console.log(`--- Folder: ${folder} ---`);
      console.log(`Count: ${filtered.length}`);
      console.log(JSON.stringify(filtered.map(f => f.Key), null, 2));
    }
  } catch (err) {
    console.error("Error:", err);
  }
}

listFiles();
