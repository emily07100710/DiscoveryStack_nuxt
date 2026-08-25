<?php

namespace App\Services\GeoFlow;

use App\Exceptions\ApiException;
use DateTimeImmutable;
use DateTimeInterface;
use DateTimeZone;
use Normalizer;
use Throwable;

/**
 * Strict, server-owned validation for the DiscoveryStack generation payload.
 *
 * The payload is intentionally stored in task_runs.meta rather than in a new
 * schema column.  It is the snake_case wire representation of the public
 * GeoFlowRequest contract, with no executable instructions outside evidence
 * data.  Every field is bounded and the two fingerprints are recomputed from
 * the normalized camelCase contract used by DiscoveryStack.
 */
final class DiscoveryStackGenerationPayload
{
    public const JOB_TYPE = 'discoverystack_generate_article_v1';

    private const PROTOCOL_VERSION = 'discoverystack-geoflow-v1';
    private const PAYLOAD_KEYS = [
        'protocol_version',
        'request_id',
        'request_fingerprint',
        'idempotency_key',
        'owner_user_id',
        'client_id',
        'calendar_entry_id',
        'production_plan_id',
        'deliverable_id',
        'brief_id',
        'discovery_stack_job_id',
        'evidence_snapshot_hash',
        'brief_fingerprint',
        'brief',
        'content_type',
        'language',
        'generation_mode',
        'revision_context',
        'requested_capabilities',
        'selected_rule_ids',
        'authority_source_ids',
        'evidence_chunks',
        'created_at',
        'attempt',
        'external_article_key',
    ];

    private const BRIEF_KEYS = ['title', 'audience', 'goals', 'constraints'];
    private const REVISION_KEYS = ['parent_draft_id', 'parent_content_hash', 'change_request_review_id', 'instructions'];
    private const EVIDENCE_KEYS = ['source_id', 'artifact_id', 'chunk_id', 'chunk_hash', 'reviewed_text', 'locator'];
    private const HASH_PATTERN = '/^[0-9a-f]{64}$/';
    private const OPAQUE_PATTERN = '/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/';
    private const CONTROL_CHARACTERS = '/[\x00-\x1f\x7f-\x9f]/u';
    private const SENSITIVE_QUERY_TOKEN_PATTERN = '/(?:authorization|bearer|cookie|credential|password|secret|token|api_key|api-key|access_token|access-token|signature|private_key)/iu';
    private const MALFORMED_PERCENT_ENCODING = '/%(?![0-9a-f]{2})/i';
    private const SPECIAL_USE_HOST_SUFFIXES = ['alt', 'arpa', 'example', 'example.com', 'example.net', 'example.org', 'invalid', 'local', 'localhost', 'onion', 'test'];

    /**
     * @param array<string,mixed> $payload
     * @return array<string,mixed>
     */
    public static function validate(array $payload): array
    {
        self::assertExactKeys($payload, self::PAYLOAD_KEYS, '$payload');

        $protocol = self::exactString($payload['protocol_version'], self::PROTOCOL_VERSION, '$payload.protocol_version');
        $requestId = self::requestId($payload['request_id'], '$payload.request_id');
        $requestFingerprint = self::hashValue($payload['request_fingerprint'], '$payload.request_fingerprint');
        $idempotencyKey = self::requestId($payload['idempotency_key'], '$payload.idempotency_key');
        $ownerUserId = self::positiveInteger($payload['owner_user_id'], '$payload.owner_user_id');
        $clientId = self::positiveInteger($payload['client_id'], '$payload.client_id');
        $calendarEntryId = self::positiveInteger($payload['calendar_entry_id'], '$payload.calendar_entry_id');
        $productionPlanId = self::positiveInteger($payload['production_plan_id'], '$payload.production_plan_id');
        $deliverableId = self::positiveInteger($payload['deliverable_id'], '$payload.deliverable_id');
        $briefId = self::positiveInteger($payload['brief_id'], '$payload.brief_id');
        $discoveryStackJobId = self::positiveInteger($payload['discovery_stack_job_id'], '$payload.discovery_stack_job_id');
        $evidenceSnapshotHash = self::hashValue($payload['evidence_snapshot_hash'], '$payload.evidence_snapshot_hash');
        $briefFingerprint = self::hashValue($payload['brief_fingerprint'], '$payload.brief_fingerprint');
        $brief = self::brief($payload['brief']);
        $contentType = self::enumValue($payload['content_type'], ['article', 'faq', 'service_page'], '$payload.content_type');
        $language = self::enumValue($payload['language'], ['zh-hant', 'en'], '$payload.language');
        $generationMode = self::enumValue($payload['generation_mode'], ['draft', 'revision'], '$payload.generation_mode');
        $revisionContext = self::revisionContext($payload['revision_context'], $generationMode);
        $requestedCapabilities = self::setArray($payload['requested_capabilities'], 10, '$payload.requested_capabilities');
        $allowedCapabilities = ['knowledge_rag', 'prompt_pack', 'qwen_generation', 'autogeo_optimization', 'human_review'];
        foreach ($requestedCapabilities as $capability) {
            if (! in_array($capability, $allowedCapabilities, true)) {
                self::invalid('$payload.requested_capabilities', 'unsupported capability');
            }
        }
        $selectedRuleIds = self::setArray($payload['selected_rule_ids'], 30, '$payload.selected_rule_ids');
        $authoritySourceIds = self::setArray($payload['authority_source_ids'], 50, '$payload.authority_source_ids');
        $evidenceChunks = self::evidenceChunks($payload['evidence_chunks'], $authoritySourceIds);
        if (in_array('knowledge_rag', $requestedCapabilities, true) && ($authoritySourceIds === [] || $evidenceChunks === [])) {
            self::invalid('$payload.evidence_chunks', 'knowledge_rag requires approved evidence');
        }
        if (in_array('autogeo_optimization', $requestedCapabilities, true) && $selectedRuleIds === []) {
            self::invalid('$payload.selected_rule_ids', 'autogeo_optimization requires selected rules');
        }
        $createdAt = self::timestamp($payload['created_at'], '$payload.created_at');
        $attempt = self::attempt($payload['attempt'], '$payload.attempt');
        $externalArticleKey = self::opaque($payload['external_article_key'], '$payload.external_article_key');
        $expectedArticleKey = self::externalArticleKey($calendarEntryId, $deliverableId);
        if ($externalArticleKey !== $expectedArticleKey) {
            self::invalid('$payload.external_article_key', 'external article key does not match request identity');
        }

        $normalized = [
            'protocol_version' => $protocol,
            'request_id' => $requestId,
            'request_fingerprint' => $requestFingerprint,
            'idempotency_key' => $idempotencyKey,
            'owner_user_id' => $ownerUserId,
            'client_id' => $clientId,
            'calendar_entry_id' => $calendarEntryId,
            'production_plan_id' => $productionPlanId,
            'deliverable_id' => $deliverableId,
            'brief_id' => $briefId,
            'discovery_stack_job_id' => $discoveryStackJobId,
            'evidence_snapshot_hash' => $evidenceSnapshotHash,
            'brief_fingerprint' => $briefFingerprint,
            'brief' => $brief,
            'content_type' => $contentType,
            'language' => $language,
            'generation_mode' => $generationMode,
            'revision_context' => $revisionContext,
            'requested_capabilities' => $requestedCapabilities,
            'selected_rule_ids' => $selectedRuleIds,
            'authority_source_ids' => $authoritySourceIds,
            'evidence_chunks' => $evidenceChunks,
            'created_at' => $createdAt,
            'attempt' => $attempt,
            'external_article_key' => $externalArticleKey,
        ];

        $expectedBriefFingerprint = self::sha256(self::canonicalJson([
            'title' => $brief['title'],
            'audience' => $brief['audience'],
            'contentType' => $contentType,
            'language' => $language,
            'goals' => $brief['goals'],
            'constraints' => $brief['constraints'],
        ]));
        if (! hash_equals($expectedBriefFingerprint, $briefFingerprint)) {
            self::invalid('$payload.brief_fingerprint', 'brief fingerprint mismatch');
        }

        $expectedRequestFingerprint = self::sha256(self::canonicalJson(self::camelCaseDraft($normalized, $expectedBriefFingerprint)));
        if (! hash_equals($expectedRequestFingerprint, $requestFingerprint)) {
            self::invalid('$payload.request_fingerprint', 'request fingerprint mismatch');
        }

        return $normalized;
    }

    public static function externalArticleKey(int $calendarEntryId, int $deliverableId): string
    {
        return 'article-'.$calendarEntryId.'-'.$deliverableId;
    }

    /** @param array<string,mixed> $payload */
    public static function toRequestInput(array $payload): array
    {
        $normalized = self::validate($payload);

        return self::camelCaseDraft($normalized, $normalized['brief_fingerprint']) + [
            'briefFingerprint' => $normalized['brief_fingerprint'],
            'requestFingerprint' => $normalized['request_fingerprint'],
        ];
    }

    /** @param array<string,mixed> $value */
    private static function brief(mixed $value): array
    {
        if (! is_array($value)) {
            self::invalid('$payload.brief', 'brief must be an object');
        }
        self::assertExactKeys($value, self::BRIEF_KEYS, '$payload.brief');

        return [
            'title' => self::humanText($value['title'], 300, '$payload.brief.title'),
            'audience' => self::humanText($value['audience'], 300, '$payload.brief.audience'),
            'goals' => self::orderedTextArray($value['goals'], 1, 10, 500, '$payload.brief.goals'),
            'constraints' => self::orderedTextArray($value['constraints'], 0, 20, 500, '$payload.brief.constraints'),
        ];
    }

    private static function revisionContext(mixed $value, string $generationMode): ?array
    {
        if ($generationMode === 'draft') {
            if ($value !== null) {
                self::invalid('$payload.revision_context', 'draft cannot contain revision context');
            }

            return null;
        }
        if (! is_array($value)) {
            self::invalid('$payload.revision_context', 'revision requires revision context');
        }
        self::assertExactKeys($value, self::REVISION_KEYS, '$payload.revision_context');

        return [
            'parent_draft_id' => self::positiveInteger($value['parent_draft_id'], '$payload.revision_context.parent_draft_id'),
            'parent_content_hash' => self::hashValue($value['parent_content_hash'], '$payload.revision_context.parent_content_hash'),
            'change_request_review_id' => self::positiveInteger($value['change_request_review_id'], '$payload.revision_context.change_request_review_id'),
            'instructions' => self::humanText($value['instructions'], 4_000, '$payload.revision_context.instructions'),
        ];
    }

    /** @return list<array<string,mixed>> */
    private static function evidenceChunks(mixed $value, array $authoritySourceIds): array
    {
        if (! is_array($value) || count($value) > 50) {
            self::invalid('$payload.evidence_chunks', 'evidence chunks must be a bounded array');
        }
        $result = [];
        $identities = [];
        $totalBytes = 0;
        foreach (array_values($value) as $index => $chunk) {
            if (! is_array($chunk)) {
                self::invalid('$payload.evidence_chunks['.$index.']', 'chunk must be an object');
            }
            self::assertExactKeys($chunk, self::EVIDENCE_KEYS, '$payload.evidence_chunks['.$index.']');
            $sourceId = self::opaque($chunk['source_id'], '$payload.evidence_chunks['.$index.'].source_id');
            if (! in_array($sourceId, $authoritySourceIds, true)) {
                self::invalid('$payload.evidence_chunks['.$index.'].source_id', 'chunk source is not approved');
            }
            $artifactId = self::opaque($chunk['artifact_id'], '$payload.evidence_chunks['.$index.'].artifact_id');
            $chunkId = self::opaque($chunk['chunk_id'], '$payload.evidence_chunks['.$index.'].chunk_id');
            $reviewedText = self::humanText($chunk['reviewed_text'], 12_000, '$payload.evidence_chunks['.$index.'].reviewed_text');
            $chunkHash = self::hashValue($chunk['chunk_hash'], '$payload.evidence_chunks['.$index.'].chunk_hash');
            if (! hash_equals($chunkHash, self::sha256($reviewedText))) {
                self::invalid('$payload.evidence_chunks['.$index.'].chunk_hash', 'evidence chunk hash mismatch');
            }
            $locator = self::publicHttpsUrl($chunk['locator'], '$payload.evidence_chunks['.$index.'].locator');
            $identity = implode("\x00", [$sourceId, $artifactId, $chunkId]);
            if (isset($identities[$identity])) {
                self::invalid('$payload.evidence_chunks['.$index.']', 'duplicate evidence identity');
            }
            $identities[$identity] = true;
            $totalBytes += strlen($reviewedText);
            if ($totalBytes > 120_000) {
                self::invalid('$payload.evidence_chunks', 'reviewed evidence exceeds byte bound');
            }
            $result[] = [
                'source_id' => $sourceId,
                'artifact_id' => $artifactId,
                'chunk_id' => $chunkId,
                'chunk_hash' => $chunkHash,
                'reviewed_text' => $reviewedText,
                'locator' => $locator,
            ];
        }

        return $result;
    }

    /** @return list<string> */
    private static function setArray(mixed $value, int $max, string $path): array
    {
        if (! is_array($value) || count($value) > $max) {
            self::invalid($path, 'bounded set array required');
        }
        $result = [];
        foreach (array_values($value) as $index => $item) {
            $normalized = self::opaque($item, $path.'['.$index.']');
            if (in_array($normalized, $result, true)) {
                self::invalid($path.'['.$index.']', 'duplicate identifier');
            }
            $result[] = $normalized;
        }
        sort($result, SORT_STRING);

        return $result;
    }

    /** @return list<string> */
    private static function orderedTextArray(mixed $value, int $min, int $max, int $itemMax, string $path): array
    {
        if (! is_array($value) || count($value) < $min || count($value) > $max) {
            self::invalid($path, 'bounded ordered text array required');
        }
        $result = [];
        foreach (array_values($value) as $index => $item) {
            $normalized = self::humanText($item, $itemMax, $path.'['.$index.']');
            if (in_array($normalized, $result, true)) {
                self::invalid($path.'['.$index.']', 'duplicate text item');
            }
            $result[] = $normalized;
        }

        return $result;
    }

    /** @param list<string> $allowed */
    private static function enumValue(mixed $value, array $allowed, string $path): string
    {
        if (! is_string($value) || ! in_array($value, $allowed, true)) {
            self::invalid($path, 'unexpected enum value');
        }

        return $value;
    }

    private static function exactString(mixed $value, string $expected, string $path): string
    {
        if (! is_string($value) || $value !== $expected) {
            self::invalid($path, 'unexpected value');
        }

        return $value;
    }

    private static function requestId(mixed $value, string $path): string
    {
        if (! is_string($value) || strlen($value) < 1 || strlen($value) > 128 || ! preg_match('/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/', $value)) {
            self::invalid($path, 'invalid request identifier');
        }

        return $value;
    }

    private static function positiveInteger(mixed $value, string $path): int
    {
        if (! is_int($value) || $value <= 0) {
            self::invalid($path, 'positive integer required');
        }

        return $value;
    }

    private static function attempt(mixed $value, string $path): int
    {
        if (! is_int($value) || $value < 1 || $value > 10) {
            self::invalid($path, 'attempt must be between 1 and 10');
        }

        return $value;
    }

    private static function humanText(mixed $value, int $max, string $path): string
    {
        if (! is_string($value) || preg_match(self::CONTROL_CHARACTERS, $value)) {
            self::invalid($path, 'invalid text');
        }
        if (! class_exists(Normalizer::class)) {
            self::invalid($path, 'Unicode normalization is unavailable');
        }
        $normalized = Normalizer::normalize($value, Normalizer::FORM_KC);
        if (! is_string($normalized)) {
            self::invalid($path, 'Unicode normalization failed');
        }
        $normalized = preg_replace('/\s+/u', ' ', trim($normalized));
        if (! is_string($normalized) || $normalized === '' || self::utf16Length($normalized) > $max) {
            self::invalid($path, 'text is empty or exceeds bound');
        }

        return $normalized;
    }

    private static function utf16Length(string $value): int
    {
        $encoded = mb_convert_encoding($value, 'UTF-16LE', 'UTF-8');

        return intdiv(strlen($encoded), 2);
    }

    private static function opaque(mixed $value, string $path): string
    {
        if (! is_string($value) || strlen($value) < 1 || strlen($value) > 160 || preg_match(self::CONTROL_CHARACTERS, $value) || ! preg_match(self::OPAQUE_PATTERN, $value)) {
            self::invalid($path, 'invalid opaque identifier');
        }

        return $value;
    }

    private static function hashValue(mixed $value, string $path): string
    {
        if (! is_string($value) || ! preg_match(self::HASH_PATTERN, $value)) {
            self::invalid($path, 'invalid sha-256 hash');
        }

        return $value;
    }

    private static function timestamp(mixed $value, string $path): string
    {
        if (! is_string($value) || ! preg_match('/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/', $value, $matches)) {
            self::invalid($path, 'invalid ISO timestamp');
        }
        $year = (int) $matches[1];
        $month = (int) $matches[2];
        $day = (int) $matches[3];
        $hour = (int) $matches[4];
        $minute = (int) $matches[5];
        $second = (int) $matches[6];
        $offset = (string) $matches[7];
        $offsetHour = $offset === 'Z' ? 0 : (int) substr($offset, 1, 2);
        $offsetMinute = $offset === 'Z' ? 0 : (int) substr($offset, 4, 2);
        if (! checkdate($month, $day, $year) || $hour > 23 || $minute > 59 || $second > 59 || ($offset !== 'Z' && ($offset === '-00:00' || $offsetHour > 14 || $offsetMinute > 59 || ($offsetHour === 14 && $offsetMinute !== 0)))) {
            self::invalid($path, 'invalid timestamp');
        }
        try {
            $date = new DateTimeImmutable($value);
            if ($date->getOffset() === false) {
                self::invalid($path, 'invalid timestamp offset');
            }

            return $date->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z');
        } catch (Throwable) {
            self::invalid($path, 'invalid timestamp');
        }
    }

    private static function publicHttpsUrl(mixed $value, string $path): string
    {
        if (! is_string($value) || self::utf16Length($value) > 2_048 || preg_match(self::CONTROL_CHARACTERS, $value) || preg_match(self::MALFORMED_PERCENT_ENCODING, $value)) {
            self::invalid($path, 'invalid locator');
        }
        $parts = parse_url($value);
        if (! is_array($parts)) {
            self::invalid($path, 'invalid locator');
        }
        $scheme = strtolower((string) ($parts['scheme'] ?? ''));
        if ($scheme !== 'https' || empty($parts['host']) || array_key_exists('user', $parts) || array_key_exists('pass', $parts) || array_key_exists('fragment', $parts)) {
            self::invalid($path, 'locator must be public HTTPS');
        }
        if (isset($parts['port']) && (int) $parts['port'] !== 443) {
            self::invalid($path, 'locator port is not public HTTPS');
        }
        $host = strtolower((string) $parts['host']);
        $ipHost = trim($host, '[]');
        $specialUseHost = false;
        foreach (self::SPECIAL_USE_HOST_SUFFIXES as $suffix) {
            if ($ipHost === $suffix || str_ends_with($ipHost, '.'.$suffix)) {
                $specialUseHost = true;
                break;
            }
        }
        $specialUseHost = $specialUseHost || $ipHost === 'home.arpa' || str_ends_with($ipHost, '.home.arpa');
        if ($ipHost === '' || $specialUseHost || $ipHost === 'localhost' || $ipHost === 'local' || $ipHost === 'internal' || $ipHost === 'onion' || str_ends_with($ipHost, '.local') || str_ends_with($ipHost, '.internal') || str_ends_with($ipHost, '.localhost') || str_ends_with($ipHost, '.onion')) {
            self::invalid($path, 'locator target is not a public hostname');
        }
        if (isset($parts['query'])) {
            foreach (explode('&', (string) $parts['query']) as $pair) {
                [$rawName, $rawValue] = array_pad(explode('=', $pair, 2), 2, '');
                $name = str_replace('+', ' ', rawurldecode($rawName));
                $queryValue = str_replace('+', ' ', rawurldecode($rawValue));
                if (preg_match(self::SENSITIVE_QUERY_TOKEN_PATTERN, $name) || preg_match(self::SENSITIVE_QUERY_TOKEN_PATTERN, $queryValue)) {
                    self::invalid($path, 'locator query contains a credential-like value');
                }
            }
        }
        if (filter_var($ipHost, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false || filter_var($ipHost, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) !== false) {
            self::invalid($path, 'locator target must use a public hostname, not an IP literal');
        }
        if (! str_contains($ipHost, '.')) {
            self::invalid($path, 'locator target is not a public hostname');
        }

        $canonical = 'https://'.$ipHost;
        $canonical .= (($parts['path'] ?? '') !== '') ? (string) $parts['path'] : '/';
        if (array_key_exists('query', $parts)) {
            $canonical .= '?'.(string) $parts['query'];
        }

        return $canonical;
    }

    private static function isSpecialIPv4(string $host): bool
    {
        $parts = array_map('intval', explode('.', $host));
        if (count($parts) !== 4) {
            return true;
        }
        [$a, $b, $c] = $parts;

        return $a === 0 || $a === 10 || $a === 127 || ($a === 100 && $b >= 64 && $b <= 127) || ($a === 169 && $b === 254) || ($a === 172 && $b >= 16 && $b <= 31) || ($a === 192 && ($b === 0 || $b === 168)) || ($a === 198 && ($b === 18 || $b === 19 || ($b === 51 && $c === 100))) || ($a === 203 && $b === 0 && $c === 113) || $a >= 224;
    }

    private static function isSpecialIPv6(string $host): bool
    {
        $normalized = strtolower(trim($host, '[]'));
        if ($normalized === '::' || $normalized === '::1' || str_starts_with($normalized, 'fc') || str_starts_with($normalized, 'fd') || str_starts_with($normalized, 'fe8') || str_starts_with($normalized, 'fe9') || str_starts_with($normalized, 'fea') || str_starts_with($normalized, 'feb') || str_starts_with($normalized, '100:') || str_starts_with($normalized, '2002:') || str_starts_with($normalized, '3fff:') || str_starts_with($normalized, '5f00:') || preg_match('/^(?:2001:0?db8:|2001:0{3,4}:|2001:0002:|2001:0010:|2001:0020:|2001:0030:)/', $normalized)) {
            return true;
        }
        if (preg_match('/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/', $normalized, $matches)) {
            $high = (int) hexdec($matches[1]);
            $low = (int) hexdec($matches[2]);
            $ipv4 = (($high >> 8) & 255).'.'.($high & 255).'.'.(($low >> 8) & 255).'.'.($low & 255);

            return self::isSpecialIPv4($ipv4);
        }

        return false;
    }

    /** @param array<string,mixed> $record */
    private static function assertExactKeys(array $record, array $expected, string $path): void
    {
        $actual = array_keys($record);
        sort($actual, SORT_STRING);
        $expectedSorted = $expected;
        sort($expectedSorted, SORT_STRING);
        if ($actual !== $expectedSorted) {
            self::invalid($path, 'unexpected or missing fields');
        }
    }

    /** @param array<string,mixed> $normalized */
    private static function camelCaseDraft(array $normalized, string $briefFingerprint): array
    {
        $revision = $normalized['revision_context'];
        $evidence = array_map(static fn (array $chunk): array => [
            'sourceId' => $chunk['source_id'],
            'artifactId' => $chunk['artifact_id'],
            'chunkId' => $chunk['chunk_id'],
            'chunkHash' => $chunk['chunk_hash'],
            'reviewedText' => $chunk['reviewed_text'],
            'locator' => $chunk['locator'],
        ], $normalized['evidence_chunks']);

        return [
            'protocolVersion' => $normalized['protocol_version'],
            'requestId' => $normalized['request_id'],
            'idempotencyKey' => $normalized['idempotency_key'],
            'ownerUserId' => $normalized['owner_user_id'],
            'clientId' => $normalized['client_id'],
            'calendarEntryId' => $normalized['calendar_entry_id'],
            'productionPlanId' => $normalized['production_plan_id'],
            'deliverableId' => $normalized['deliverable_id'],
            'briefId' => $normalized['brief_id'],
            'jobId' => $normalized['discovery_stack_job_id'],
            'evidenceSnapshotHash' => $normalized['evidence_snapshot_hash'],
            'brief' => [
                'title' => $normalized['brief']['title'],
                'audience' => $normalized['brief']['audience'],
                'goals' => $normalized['brief']['goals'],
                'constraints' => $normalized['brief']['constraints'],
            ],
            'contentType' => $normalized['content_type'],
            'language' => $normalized['language'],
            'generationMode' => $normalized['generation_mode'],
            'revisionContext' => $revision === null ? null : [
                'parentDraftId' => $revision['parent_draft_id'],
                'parentContentHash' => $revision['parent_content_hash'],
                'changeRequestReviewId' => $revision['change_request_review_id'],
                'instructions' => $revision['instructions'],
            ],
            'requestedCapabilities' => $normalized['requested_capabilities'],
            'selectedRuleIds' => $normalized['selected_rule_ids'],
            'authoritySourceIds' => $normalized['authority_source_ids'],
            'evidenceChunks' => $evidence,
            'createdAt' => $normalized['created_at'],
            'briefFingerprint' => $briefFingerprint,
        ];
    }

    private static function canonicalJson(mixed $value): string
    {
        if (is_array($value)) {
            if (! array_is_list($value)) {
                ksort($value, SORT_STRING);
            }
            $value = array_map([self::class, 'canonicalizeArrayValue'], $value);
        }

        try {
            return json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR);
        } catch (Throwable) {
            self::invalid('$payload', 'payload is not canonicalizable');
        }
    }

    private static function canonicalizeArrayValue(mixed $value): mixed
    {
        if (! is_array($value)) {
            return $value;
        }
        if (! array_is_list($value)) {
            ksort($value, SORT_STRING);
        }

        return array_map([self::class, 'canonicalizeArrayValue'], $value);
    }

    private static function sha256(string $value): string
    {
        return hash('sha256', $value);
    }

    private static function invalid(string $path, string $message): never
    {
        throw new ApiException('discoverystack_payload_invalid', $message, 422, [
            'field' => $path,
        ]);
    }
}
