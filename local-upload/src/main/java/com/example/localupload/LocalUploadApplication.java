package com.example.localupload;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class LocalUploadApplication {
    public static void main(String[] args) {
        SpringApplication.run(LocalUploadApplication.class, args);
    }
}
