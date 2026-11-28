package com.cmpt276group18.audio_project.service;

import java.net.URI;
import java.time.Duration;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import jakarta.annotation.PreDestroy;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.PresignedPutObjectRequest;
import software.amazon.awssdk.services.s3.presigner.model.PutObjectPresignRequest;

@Service
public class R2StorageService {

    private static final Pattern SHA256_PATTERN = Pattern.compile("^[a-f0-9]{64}$");
    private static final Set<String> ALLOWED_EXTENSIONS = Set.of("wav", "mp3", "ogg", "flac", "m4a");
    public static final String CACHE_CONTROL = "public, max-age=31536000, immutable";

    private final String bucket;
    private final String publicBaseUrl;
    private final S3Presigner presigner;

    public R2StorageService(
            @Value("${cloudflare.r2.account-id:}") String accountId,
            @Value("${cloudflare.r2.access-key-id:}") String accessKeyId,
            @Value("${cloudflare.r2.secret-access-key:}") String secretAccessKey,
            @Value("${cloudflare.r2.bucket:cmpt276-daw-samples}") String bucket,
            @Value("${cloudflare.r2.public-url:}") String publicBaseUrl) {
        this.bucket = bucket;
        this.publicBaseUrl = publicBaseUrl.endsWith("/")
                ? publicBaseUrl.substring(0, publicBaseUrl.length() - 1)
                : publicBaseUrl;

        if (!accountId.isBlank() && !accessKeyId.isBlank() && !secretAccessKey.isBlank()) {
            this.presigner = S3Presigner.builder()
                    .endpointOverride(URI.create("https://" + accountId + ".r2.cloudflarestorage.com"))
                    .region(Region.of("auto"))
                    .credentialsProvider(StaticCredentialsProvider.create(
                            AwsBasicCredentials.create(accessKeyId, secretAccessKey)))
                    .serviceConfiguration(S3Configuration.builder()
                            .pathStyleAccessEnabled(true)
                            .build())
                    .build();
        } else {
            this.presigner = null;
        }
    }

    public PresignedUpload createSampleUpload(UUID projectId, String sha256, String fileName, String contentType) {
        if (presigner == null || publicBaseUrl.isBlank()) {
            throw new IllegalStateException("Cloudflare R2 storage is not configured on the server");
        }
        if (sha256 == null || !SHA256_PATTERN.matcher(sha256).matches()) {
            throw new IllegalArgumentException("Invalid sample SHA-256 identifier");
        }
        if (contentType == null || !contentType.startsWith("audio/")) {
            throw new IllegalArgumentException("Only audio files are allowed");
        }

        String ext = extractExtension(fileName);
        String objectKey = "projects/" + projectId + "/" + sha256 + "." + ext;

        PutObjectRequest putRequest = PutObjectRequest.builder()
                .bucket(bucket)
                .key(objectKey)
                .contentType(contentType)
                .cacheControl(CACHE_CONTROL)
                .build();

        PutObjectPresignRequest presignRequest = PutObjectPresignRequest.builder()
                .signatureDuration(Duration.ofMinutes(10))
                .putObjectRequest(putRequest)
                .build();

        PresignedPutObjectRequest presigned = presigner.presignPutObject(presignRequest);
        return new PresignedUpload(presigned.url().toString(), publicBaseUrl + "/" + objectKey, objectKey);
    }

    private String extractExtension(String fileName) {
        if (fileName != null) {
            int dot = fileName.lastIndexOf('.');
            if (dot >= 0 && dot < fileName.length() - 1) {
                String ext = fileName.substring(dot + 1).toLowerCase();
                if (ALLOWED_EXTENSIONS.contains(ext)) {
                    return ext;
                }
            }
        }
        return "wav";
    }

    @PreDestroy
    public void close() {
        if (presigner != null) {
            presigner.close();
        }
    }

    public record PresignedUpload(String uploadUrl, String publicUrl, String objectKey) {}
}