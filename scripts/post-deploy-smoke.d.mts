export interface PostDeployCheckItem {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerifyDeployedEndpointOptions {
  target: 'personal' | 'demo';
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface VerifyDeployedEndpointResult {
  passed: boolean;
  target: 'personal' | 'demo';
  baseUrl: string;
  checks: PostDeployCheckItem[];
}

export function verifyDeployedEndpoint(
  options: VerifyDeployedEndpointOptions
): Promise<VerifyDeployedEndpointResult>;
