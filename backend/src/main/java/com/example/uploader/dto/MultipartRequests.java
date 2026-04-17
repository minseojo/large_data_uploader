package com.example.uploader.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;
import java.util.Map;

public class MultipartRequests {

    public record CreateRequest(String filename, String contentType, long size) {}

    public record CreateResponse(String uploadId, String key) {}

    public record SignPartRequest(String uploadId, String key, int partNumber) {}

    public record SignPartResponse(String url) {}

    public record SignPartsRequest(String uploadId, String key, List<Integer> partNumbers) {}

    public record SignPartsResponse(Map<Integer, String> presignedUrls) {}

    public record CompletePart(@JsonProperty("PartNumber") int partNumber,
                               @JsonProperty("ETag") String eTag) {}

    public record CompleteRequest(String uploadId, String key, List<CompletePart> parts) {}

    public record CompleteResponse(String location) {}

    public record AbortRequest(String uploadId, String key) {}

    public record PartInfo(int partNumber, String eTag, long size) {}
}
