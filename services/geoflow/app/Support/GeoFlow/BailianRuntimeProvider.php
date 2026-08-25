<?php

namespace App\Support\GeoFlow;

use InvalidArgumentException;

/**
 * Bailian/Qwen OpenAI-compatible contract guard.
 *
 * This class is deliberately pure: it validates and canonicalizes configuration,
 * request metadata, provider responses, and safe diagnostics. It never performs
 * network I/O and never accepts a caller-selected arbitrary provider endpoint.
 */
final class BailianRuntimeProvider
{
    public const PROVIDER = 'bailian';

    public const PROVIDER_MODE = 'openai-compatible';

    public const CANONICAL_PATH = '/compatible-mode/v1';

    public const CHAT_PATH = '/chat/completions';

    public const MAX_MODEL_LENGTH = 128;

    public const MAX_CONTENT_LENGTH = 200000;

    public const MAX_REQUEST_ID_LENGTH = 200;

    /**
     * @return array<string,string>
     */
    public static function sharedBaseUrls(): array
    {
        return [
            'china' => 'https://dashscope.aliyuncs.com'.self::CANONICAL_PATH,
            'international' => 'https://dashscope-intl.aliyuncs.com'.self::CANONICAL_PATH,
            'us' => 'https://dashscope-us.aliyuncs.com'.self::CANONICAL_PATH,
        ];
    }

    /**
     * @return array<string,string>
     */
    public static function workspaceRegionSuffixes(): array
    {
        return [
            'beijing' => 'cn-beijing',
            'singapore' => 'ap-southeast-1',
            'japan' => 'ap-northeast-1',
            'us-east' => 'us-east-1',
        ];
    }

    public static function isOfficialBailianUrl(string $url): bool
    {
        try {
            self::normalizeBaseUrl($url);

            return true;
        } catch (InvalidArgumentException) {
            return false;
        }
    }

    public static function isQwenModelId(string $modelId): bool
    {
        try {
            self::normalizeModelId($modelId);

            return true;
        } catch (InvalidArgumentException) {
            return false;
        }
    }

    public static function requiresBailianPolicy(string $url, string $modelId): bool
    {
        $normalizedModel = strtolower(trim($modelId));
        $host = strtolower((string) (parse_url(trim($url), PHP_URL_HOST) ?? ''));

        return str_starts_with($normalizedModel, 'qwen')
            || $host === 'dashscope.aliyuncs.com'
            || $host === 'dashscope-intl.aliyuncs.com'
            || $host === 'dashscope-us.aliyuncs.com'
            || str_ends_with($host, '.maas.aliyuncs.com');
    }

    public static function normalizeBaseUrl(string $url): string
    {
        $candidate = trim($url);
        if ($candidate === '' || preg_match('/[\x00-\x20\x7F]/u', $candidate) === 1) {
            throw new InvalidArgumentException('invalid_configuration');
        }

        $parts = parse_url($candidate);
        if (! is_array($parts)) {
            throw new InvalidArgumentException('invalid_configuration');
        }

        $scheme = strtolower((string) ($parts['scheme'] ?? ''));
        $host = strtolower((string) ($parts['host'] ?? ''));
        $port = $parts['port'] ?? null;
        $path = (string) ($parts['path'] ?? '');

        if ($scheme !== 'https' || $host === '' || ($port !== null && (int) $port !== 443)) {
            throw new InvalidArgumentException('invalid_configuration');
        }
        if (array_key_exists('user', $parts) || array_key_exists('pass', $parts) || array_key_exists('query', $parts) || array_key_exists('fragment', $parts)) {
            throw new InvalidArgumentException('invalid_configuration');
        }
        if (filter_var($host, FILTER_VALIDATE_IP) !== false || str_contains($host, ':')) {
            throw new InvalidArgumentException('invalid_configuration');
        }
        if (str_contains($path, '%') || str_contains($path, chr(92)) || str_contains($path, '//') || str_contains($path, '/../') || str_contains($path, '/./')) {
            throw new InvalidArgumentException('invalid_configuration');
        }

        $region = self::regionForHost($host);
        if ($region === null) {
            throw new InvalidArgumentException('invalid_configuration');
        }

        if (rtrim($path, '/') !== self::CANONICAL_PATH) {
            throw new InvalidArgumentException('invalid_configuration');
        }

        return 'https://'.$host.self::CANONICAL_PATH;
    }

    public static function resolveRegion(string $url): string
    {
        $base = self::normalizeBaseUrl($url);
        $host = strtolower((string) parse_url($base, PHP_URL_HOST));
        $region = self::regionForHost($host);
        if ($region === null) {
            throw new InvalidArgumentException('invalid_configuration');
        }

        return $region;
    }

    public static function normalizeWorkspaceId(string $workspaceId): string
    {
        $normalized = trim($workspaceId);
        if ($normalized === '' || strlen($normalized) > 63 || preg_match('/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/', $normalized) !== 1) {
            throw new InvalidArgumentException('invalid_configuration');
        }

        return $normalized;
    }

    public static function normalizeModelId(string $modelId): string
    {
        $normalized = trim($modelId);
        if ($normalized === '' || strlen($normalized) > self::MAX_MODEL_LENGTH) {
            throw new InvalidArgumentException('invalid_configuration');
        }
        if (preg_match('/^qwen[A-Za-z0-9._-]*$/', $normalized) !== 1) {
            throw new InvalidArgumentException('unsupported_model');
        }
        if (str_contains($normalized, '..') || str_contains($normalized, '//') || str_contains($normalized, chr(92))) {
            throw new InvalidArgumentException('invalid_configuration');
        }
        if (str_contains(strtolower($normalized), 'ignore previous') || str_contains(strtolower($normalized), 'system:')) {
            throw new InvalidArgumentException('invalid_configuration');
        }

        return $normalized;
    }

    /**
     * @return array{provider:string,providerMode:string,baseUrl:string,endpoint:string,region:string,modelId:string}
     */
    public static function assertAllowedConfiguration(string $baseUrl, string $modelId): array
    {
        $canonicalBase = self::normalizeBaseUrl($baseUrl);
        $normalizedModel = self::normalizeModelId($modelId);

        return [
            'provider' => self::PROVIDER,
            'providerMode' => self::PROVIDER_MODE,
            'baseUrl' => $canonicalBase,
            'endpoint' => $canonicalBase.self::CHAT_PATH,
            'region' => self::resolveRegion($canonicalBase),
            'modelId' => $normalizedModel,
        ];
    }

    /**
     * @param  array<string,mixed>  $messages
     * @return array{model:string,messages:array<int,mixed>,stream:bool,temperature:float,max_tokens:int}
     */
    public static function buildChatRequest(string $modelId, array $messages, int $maxTokens = 256, float $temperature = 0.2): array
    {
        $model = self::normalizeModelId($modelId);
        if ($messages === [] || count($messages) > 100) {
            throw new InvalidArgumentException('invalid_configuration');
        }
        if ($maxTokens < 1 || $maxTokens > 1000000 || ! is_finite((float) $maxTokens)) {
            throw new InvalidArgumentException('invalid_configuration');
        }
        if ($temperature < 0 || $temperature > 2 || ! is_finite($temperature)) {
            throw new InvalidArgumentException('invalid_configuration');
        }
        foreach ($messages as $message) {
            if (! is_array($message) || ! isset($message['role'], $message['content']) || ! is_string($message['role']) || ! is_string($message['content'])) {
                throw new InvalidArgumentException('invalid_configuration');
            }
            if (! in_array($message['role'], ['system', 'user', 'assistant'], true) || trim($message['content']) === '') {
                throw new InvalidArgumentException('invalid_configuration');
            }
        }

        return [
            'model' => $model,
            'messages' => array_values($messages),
            'stream' => false,
            'temperature' => $temperature,
            'max_tokens' => $maxTokens,
        ];
    }

    /**
     * @return array{content:string,finishReason:?string,usage:array{prompt_tokens:int,completion_tokens:int,total_tokens:int},requestId:?string}
     */
    public static function validateChatResponse(mixed $payload): array
    {
        if (! is_array($payload) || ! isset($payload['choices']) || ! is_array($payload['choices']) || ! isset($payload['choices'][0]) || ! is_array($payload['choices'][0])) {
            throw new InvalidArgumentException('malformed_json');
        }

        $choice = $payload['choices'][0];
        $message = $choice['message'] ?? null;
        $content = is_array($message) ? ($message['content'] ?? null) : null;
        if (! is_string($content) || trim($content) === '' || strlen($content) > self::MAX_CONTENT_LENGTH || preg_match('/(?:^|\R)\s*data:/iu', $content) === 1) {
            throw new InvalidArgumentException('empty_content');
        }

        $finishReason = $choice['finish_reason'] ?? null;
        if ($finishReason !== null && (! is_string($finishReason) || strlen($finishReason) > 64)) {
            throw new InvalidArgumentException('malformed_json');
        }

        $usage = $payload['usage'] ?? [];
        if (! is_array($usage)) {
            throw new InvalidArgumentException('malformed_json');
        }
        $normalizedUsage = [];
        foreach (['prompt_tokens', 'completion_tokens', 'total_tokens'] as $field) {
            if (! array_key_exists($field, $usage)) {
                throw new InvalidArgumentException('malformed_json');
            }
            $value = $usage[$field];
            if (! is_int($value) || $value < 0 || $value > PHP_INT_MAX) {
                throw new InvalidArgumentException('malformed_json');
            }
            $normalizedUsage[$field] = $value;
        }

        $requestId = null;
        if (array_key_exists('id', $payload)) {
            if (! is_string($payload['id']) || strlen($payload['id']) < 1 || strlen($payload['id']) > self::MAX_REQUEST_ID_LENGTH || preg_match('/[^A-Za-z0-9._:-]/', $payload['id']) === 1) {
                throw new InvalidArgumentException('malformed_json');
            }
            $requestId = $payload['id'];
        }

        return [
            'content' => trim($content),
            'finishReason' => $finishReason,
            'usage' => $normalizedUsage,
            'requestId' => $requestId,
        ];
    }

    public static function classifyHttpFailure(int $status): string
    {
        return match (true) {
            $status === 401 => 'unauthorized',
            $status === 403 => 'forbidden',
            $status === 429 => 'rate_limited',
            $status >= 500 && $status <= 599 => 'provider_5xx',
            $status >= 400 && $status <= 499 => 'invalid_configuration',
            default => 'network_failure',
        };
    }

    public static function shouldRetry(string $errorClass, int $attempt, int $maxRetries = 2): bool
    {
        if ($attempt < 1 || $attempt > $maxRetries || $maxRetries > 3) {
            return false;
        }

        return in_array($errorClass, ['rate_limited', 'provider_5xx', 'timeout', 'network_failure'], true);
    }

    public static function redactProviderError(string $message, string $apiKey = ''): string
    {
        $redacted = $apiKey !== '' ? str_replace($apiKey, '[redacted]', $message) : $message;
        $redacted = preg_replace('/\bBearer\s+[A-Za-z0-9._~+\/=:-]{8,}/iu', 'Bearer [redacted]', $redacted) ?? $redacted;
        $redacted = preg_replace('/\bsk-[A-Za-z0-9_-]{8,}\b/u', '[redacted]', $redacted) ?? $redacted;
        $redacted = preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $redacted) ?? $redacted;
        $redacted = trim(preg_replace('/\s+/u', ' ', $redacted) ?? $redacted);

        return mb_substr($redacted, 0, 500, 'UTF-8');
    }

    /**
     * @param  array{provider:string,providerMode:string,baseUrl:string,endpoint:string,region:string,modelId:string}  $configuration
     * @param  array<string,mixed>  $usage
     * @return array<string,mixed>
     */
    public static function buildProvenance(array $configuration, ?string $requestId, ?string $finishReason, array $usage, string $attemptedAt, int $responseStatus, string $fallbackStatus = 'none'): array
    {
        if ($responseStatus < 100 || $responseStatus > 599 || ! preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/', $attemptedAt)) {
            throw new InvalidArgumentException('invalid_configuration');
        }
        if ($requestId !== null && (strlen($requestId) > self::MAX_REQUEST_ID_LENGTH || preg_match('/[^A-Za-z0-9._:-]/', $requestId) === 1)) {
            throw new InvalidArgumentException('invalid_configuration');
        }
        foreach (['prompt_tokens', 'completion_tokens', 'total_tokens'] as $field) {
            if (! isset($usage[$field]) || ! is_int($usage[$field]) || $usage[$field] < 0) {
                throw new InvalidArgumentException('invalid_configuration');
            }
        }
        if (! in_array($fallbackStatus, ['none', 'available', 'used', 'failed'], true)) {
            throw new InvalidArgumentException('invalid_configuration');
        }

        return [
            'provider' => self::PROVIDER,
            'region' => $configuration['region'],
            'canonicalBaseHost' => (string) parse_url($configuration['baseUrl'], PHP_URL_HOST),
            'modelId' => $configuration['modelId'],
            'providerMode' => self::PROVIDER_MODE,
            'requestId' => $requestId,
            'finishReason' => $finishReason,
            'usage' => [
                'prompt_tokens' => $usage['prompt_tokens'],
                'completion_tokens' => $usage['completion_tokens'],
                'total_tokens' => $usage['total_tokens'],
            ],
            'attemptedAt' => $attemptedAt,
            'responseStatus' => $responseStatus,
            'fallbackStatus' => $fallbackStatus,
        ];
    }

    private static function regionForHost(string $host): ?string
    {
        return match ($host) {
            'dashscope.aliyuncs.com' => 'china',
            'dashscope-intl.aliyuncs.com' => 'international',
            'dashscope-us.aliyuncs.com' => 'us',
            default => self::workspaceRegionForHost($host),
        };
    }

    private static function workspaceRegionForHost(string $host): ?string
    {
        foreach (self::workspaceRegionSuffixes() as $region => $suffix) {
            $pattern = '/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.'.preg_quote($suffix, '/').'\.maas\.aliyuncs\.com$/';
            if (preg_match($pattern, $host) === 1) {
                return $region;
            }
        }

        return null;
    }
}
