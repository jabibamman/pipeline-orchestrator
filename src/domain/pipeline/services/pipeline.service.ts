import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { CreatePipelineDto, PayloadDto, StepDto, StepResultDto } from '@application/pipeline/dto/pipeline.dto';
import { lastValueFrom } from 'rxjs';
import { HttpService } from '@nestjs/axios';
import { configService } from '@infra/config/config.service';

@Injectable()
export class PipelineService {
    private readonly logger = new Logger('PipelineService');
    private readonly domain = configService.getDomain();

    constructor(private readonly httpService: HttpService) { }

    async executePipeline(createPipelineDto: CreatePipelineDto, sendUpdate?: (update: StepResultDto) => void): Promise<string | null> {
        const { steps } = createPipelineDto;
        this.validateSteps(steps);

        let inputData: string | null = null;

        for (const [index, step] of steps.entries()) {
            const { service, endpoint, payload } = step;
            const formattedEndpoint = this.formatEndpoint(endpoint);


            try {
                if (payload.code.startsWith('http')) {
                    payload.code = await this.fetchRawContentFromUrl(payload.code);
                }

                let requestData = { ...payload };

                if (payload.input?.bufferInput) {
                    const buffer = Buffer.from(payload.input.bufferInput.data);
                    requestData.input = { bufferInput: { data: new Uint8Array(buffer) } };
                }

                const response = await this.makeHttpPostRequest(service, formattedEndpoint, requestData);

                const responseData = this.extractOutputFromResponse(response, service, formattedEndpoint);
                inputData = responseData.output;

                const stepResult: StepResultDto = {
                    output: responseData.output,
                    error: '',
                    stepNumber: index + 1,
                    output_file_content: responseData.output_file_content,
                    output_file_path: responseData.output_file_path
                };


                if (sendUpdate) {
                    sendUpdate(stepResult);
                }
            } catch (error) {
                const stepResult: StepResultDto = {
                    output: '',
                    error: error.response?.data?.error || error.message || 'An unexpected error occurred',
                    stepNumber: index + 1,
                };

                if (sendUpdate) {
                    sendUpdate(stepResult);
                }

                this.handleHttpError(error, service, formattedEndpoint);
            }
        }

        return inputData;
    }

    private async fetchRawContentFromUrl(url: string): Promise<string> {
        try {
            const response = await lastValueFrom(this.httpService.get(url, { responseType: 'text' }));
            return response.data;
        } catch (error) {
            this.logger.error(`Error fetching raw content from URL ${url}:`, error);
            throw new HttpException('Error fetching raw content', HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    private async convertBlobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as ArrayBuffer);
            reader.onerror = reject;
            reader.readAsArrayBuffer(blob);
        });
    }

    private validateSteps(steps: StepDto[]): void {
        if (!Array.isArray(steps)) {
            throw new TypeError('steps is not an array');
        }
    }

    private formatEndpoint(endpoint: string): string {
        return endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
    }

    private async makeHttpPostRequest(service: string, endpoint: string, payload: any): Promise<any> {
        const url = `http://${service}.${this.domain}/${endpoint}`;

        const formData = new FormData();
        formData.append('language', payload.language);
        formData.append('code', payload.code);

        if (payload.input?.bufferInput) {
            const buffer = Buffer.from(payload.input.bufferInput.data);
            const file = new Blob([buffer]);
            formData.append('input_file', file, 'input_file');
        }

        const response = await lastValueFrom(this.httpService.post(url, formData, {
            headers: {
                'Content-Type': 'multipart/form-data'
            }
        }));
        return response.data;
    }

    private extractOutputFromResponse(response: any, service: string, endpoint: string): any {
        if (response) {
            const { output, output_file_content, output_file_path } = response;
            return {
                output: output ? output.trim() : '',
                output_file_content: output_file_content || '',
                output_file_path: output_file_path || ''
            };
        } else {
            this.logger.error(`Invalid response structure from ${service}.${this.domain}/${endpoint}:`, response);
            throw new HttpException('Invalid response structure', HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }


    private handleHttpError(error: any, service: string, endpoint: string): void {
        if (error.response) {
            this.logger.error(`Error calling ${service}.${this.domain}/${endpoint}:`, error.response.data);
            throw new HttpException(error.response.data.error, error.response.status);
        } else {
            this.logger.error(`Unexpected error calling ${service}.${this.domain}/${endpoint}:`, error.message);
            throw new HttpException('Internal server error', HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }
}
