package com.example.uploader;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class UploaderApplication {
    public static void main(String[] args) {
        SpringApplication.run(UploaderApplication.class, args);
    }
}
