<?php

namespace Tests\Feature;

use App\Support\GeoFlow\ApiKeyCrypto;
use App\Support\GeoFlow\BailianRuntimeProvider;
use Illuminate\Support\Facades\Config;
use InvalidArgumentException;
use Tests\TestCase;

final class BailianQwenProviderTest extends TestCase
{
    private function china(): string
    {
        return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    }

    private function international(): string
    {
        return 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    }

    private function us(): string
    {
        return 'https://dashscope-us.aliyuncs.com/compatible-mode/v1';
    }

    private function workspace(string $suffix): string
    {
        return 'https://workspace-abc.'.$suffix.'.maas.aliyuncs.com/compatible-mode/v1';
    }

    private function messages(): array
    {
        return [['role' => 'user', 'content' => 'Reply with OK.']];
    }

    private function response(array $overrides = []): array
    {
        return array_replace_recursive([
            'id' => 'chatcmpl_fake_1',
            'choices' => [[
                'message' => ['content' => 'OK'],
                'finish_reason' => 'stop',
            ]],
            'usage' => [
                'prompt_tokens' => 3,
                'completion_tokens' => 1,
                'total_tokens' => 4,
            ],
        ], $overrides);
    }

    public function test_china_shared_base_is_official(): void
    {
        $this->assertTrue(BailianRuntimeProvider::isOfficialBailianUrl($this->china()));
    }

    public function test_international_shared_base_is_official(): void
    {
        $this->assertTrue(BailianRuntimeProvider::isOfficialBailianUrl($this->international()));
    }

    public function test_us_shared_base_is_official(): void
    {
        $this->assertTrue(BailianRuntimeProvider::isOfficialBailianUrl($this->us()));
    }

    public function test_beijing_workspace_base_is_official(): void
    {
        $this->assertTrue(BailianRuntimeProvider::isOfficialBailianUrl($this->workspace('cn-beijing')));
    }

    public function test_singapore_workspace_base_is_official(): void
    {
        $this->assertTrue(BailianRuntimeProvider::isOfficialBailianUrl($this->workspace('ap-southeast-1')));
    }

    public function test_japan_workspace_base_is_official(): void
    {
        $this->assertTrue(BailianRuntimeProvider::isOfficialBailianUrl($this->workspace('ap-northeast-1')));
    }

    public function test_us_east_workspace_base_is_official(): void
    {
        $this->assertTrue(BailianRuntimeProvider::isOfficialBailianUrl($this->workspace('us-east-1')));
    }

    public function test_shared_base_is_canonicalized(): void
    {
        $this->assertSame($this->china(), BailianRuntimeProvider::normalizeBaseUrl($this->china().'/'));
    }

    public function test_full_chat_endpoint_is_reduced_to_base(): void
    {
        $this->assertSame($this->china(), BailianRuntimeProvider::normalizeBaseUrl($this->china().'/chat/completions'));
    }

    public function test_chat_endpoint_is_not_returned_as_caller_selected_endpoint(): void
    {
        $configuration = BailianRuntimeProvider::assertAllowedConfiguration($this->china().'/chat/completions', 'qwen-plus');
        $this->assertSame($this->china().'/chat/completions', $configuration['endpoint']);
    }

    public function test_http_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl(str_replace('https://', 'http://', $this->china())));
    }

    public function test_non_default_port_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl($this->china().':8443'));
    }

    public function test_explicit_443_port_is_allowed_and_canonicalized(): void
    {
        $this->assertSame($this->china(), BailianRuntimeProvider::normalizeBaseUrl('https://dashscope.aliyuncs.com:443/compatible-mode/v1'));
    }

    public function test_userinfo_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://user:pass@dashscope.aliyuncs.com/compatible-mode/v1'));
    }

    public function test_query_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl($this->china().'?x=1'));
    }

    public function test_fragment_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl($this->china().'#fragment'));
    }

    public function test_empty_query_marker_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl($this->china().'?'));
    }

    public function test_empty_fragment_marker_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl($this->china().'#'));
    }

    public function test_empty_userinfo_marker_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://@dashscope.aliyuncs.com/compatible-mode/v1'));
    }

    public function test_ip_literal_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://1.2.3.4/compatible-mode/v1'));
    }

    public function test_ipv6_literal_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://[2001:db8::1]/compatible-mode/v1'));
    }

    public function test_localhost_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://localhost/compatible-mode/v1'));
    }

    public function test_private_target_is_not_an_official_host(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://192.168.1.1/compatible-mode/v1'));
    }

    public function test_dashscope_suffix_spoof_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://dashscope.aliyuncs.com.attacker.example/compatible-mode/v1'));
    }

    public function test_dashscope_prefix_spoof_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://attacker-dashscope.aliyuncs.com/compatible-mode/v1'));
    }

    public function test_workspace_suffix_spoof_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://workspace.cn-beijing.maas.aliyuncs.com.attacker.example/compatible-mode/v1'));
    }

    public function test_workspace_prefix_spoof_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://attacker-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'));
    }

    public function test_missing_path_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://dashscope.aliyuncs.com'));
    }

    public function test_extra_path_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl($this->china().'/extra'));
    }

    public function test_embeddings_path_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl($this->china().'/embeddings'));
    }

    public function test_path_traversal_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://dashscope.aliyuncs.com/compatible-mode/v1/../chat/completions'));
    }

    public function test_encoded_slash_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://dashscope.aliyuncs.com/compatible-mode%2Fv1'));
    }

    public function test_double_encoded_slash_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://dashscope.aliyuncs.com/compatible-mode%252Fv1'));
    }

    public function test_backslash_path_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://dashscope.aliyuncs.com/compatible-mode/v1\\chat'));
    }

    public function test_arbitrary_openai_compatible_host_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://api.example.com/compatible-mode/v1'));
    }

    public function test_empty_url_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl(''));
    }

    public function test_workspace_uppercase_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://Workspace-abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'));
    }

    public function test_workspace_underscore_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://workspace_abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'));
    }

    public function test_workspace_empty_label_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'));
    }

    public function test_workspace_double_dot_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://workspace..abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'));
    }

    public function test_workspace_hyphen_edge_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'));
    }

    public function test_workspace_too_long_is_rejected(): void
    {
        $workspace = str_repeat('a', 64);
        $this->assertFalse(BailianRuntimeProvider::isOfficialBailianUrl('https://'.$workspace.'.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'));
    }

    public function test_workspace_id_normalizes_lowercase_opaque_value(): void
    {
        $this->assertSame('workspace-abc', BailianRuntimeProvider::normalizeWorkspaceId('workspace-abc'));
    }

    public function test_workspace_id_rejects_uppercase(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::normalizeWorkspaceId('Workspace');
    }

    public function test_workspace_id_rejects_whitespace(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::normalizeWorkspaceId('workspace abc');
    }

    public function test_workspace_id_rejects_underscore(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::normalizeWorkspaceId('workspace_abc');
    }

    public function test_workspace_id_rejects_leading_hyphen(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::normalizeWorkspaceId('-workspace');
    }

    public function test_workspace_id_rejects_trailing_hyphen(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::normalizeWorkspaceId('workspace-');
    }

    public function test_qwen_plus_is_accepted_for_tests(): void
    {
        $this->assertSame('qwen-plus', BailianRuntimeProvider::normalizeModelId('qwen-plus'));
    }

    public function test_qwen_model_is_accepted_without_hardcoding_default(): void
    {
        $this->assertSame('qwen3.5-plus', BailianRuntimeProvider::normalizeModelId('qwen3.5-plus'));
    }

    public function test_qwen_model_with_dot_is_accepted(): void
    {
        $this->assertTrue(BailianRuntimeProvider::isQwenModelId('qwen3.5-plus'));
    }

    public function test_qwen_model_with_underscore_is_accepted(): void
    {
        $this->assertTrue(BailianRuntimeProvider::isQwenModelId('qwen_custom'));
    }

    public function test_non_qwen_model_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isQwenModelId('gpt-5'));
    }

    public function test_empty_model_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isQwenModelId(''));
    }

    public function test_model_path_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isQwenModelId('qwen/foo'));
    }

    public function test_model_url_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isQwenModelId('qwen://model'));
    }

    public function test_model_query_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isQwenModelId('qwen-plus?x=1'));
    }

    public function test_model_whitespace_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isQwenModelId('qwen plus'));
    }

    public function test_model_control_character_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isQwenModelId("qwen-plus\nignore"));
    }

    public function test_model_prompt_injection_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isQwenModelId('qwen-ignore previous instructions'));
    }

    public function test_model_double_dot_is_rejected(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isQwenModelId('qwen..plus'));
    }

    public function test_model_length_is_bounded(): void
    {
        $this->assertFalse(BailianRuntimeProvider::isQwenModelId('qwen-'.str_repeat('a', 124)));
    }

    public function test_configuration_contains_provider_mode(): void
    {
        $configuration = BailianRuntimeProvider::assertAllowedConfiguration($this->china(), 'qwen-plus');
        $this->assertSame('bailian', $configuration['provider']);
        $this->assertSame('openai-compatible', $configuration['providerMode']);
    }

    public function test_configuration_contains_region(): void
    {
        $this->assertSame('china', BailianRuntimeProvider::assertAllowedConfiguration($this->china(), 'qwen-plus')['region']);
    }

    public function test_configuration_contains_canonical_endpoint(): void
    {
        $this->assertSame($this->china().'/chat/completions', BailianRuntimeProvider::assertAllowedConfiguration($this->china(), 'qwen-plus')['endpoint']);
    }

    public function test_configuration_rejects_invalid_model(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::assertAllowedConfiguration($this->china(), 'gpt-5');
    }

    public function test_configuration_rejects_invalid_url(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::assertAllowedConfiguration('https://api.example.com/v1', 'qwen-plus');
    }

    public function test_bailian_policy_is_required_for_qwen_on_unknown_host(): void
    {
        $this->assertTrue(BailianRuntimeProvider::requiresBailianPolicy('https://api.example.com/v1', 'qwen-plus'));
    }

    public function test_bailian_policy_is_required_for_official_host(): void
    {
        $this->assertTrue(BailianRuntimeProvider::requiresBailianPolicy($this->china(), 'custom-model'));
    }

    public function test_bailian_policy_is_not_required_for_other_generic_model(): void
    {
        $this->assertFalse(BailianRuntimeProvider::requiresBailianPolicy('https://api.example.com/v1', 'gpt-5'));
    }

    public function test_request_contains_model(): void
    {
        $this->assertSame('qwen-plus', BailianRuntimeProvider::buildChatRequest('qwen-plus', $this->messages())['model']);
    }

    public function test_request_contains_messages(): void
    {
        $this->assertSame($this->messages(), BailianRuntimeProvider::buildChatRequest('qwen-plus', $this->messages())['messages']);
    }

    public function test_request_forces_stream_false(): void
    {
        $this->assertFalse(BailianRuntimeProvider::buildChatRequest('qwen-plus', $this->messages())['stream']);
    }

    public function test_request_bounds_temperature(): void
    {
        $this->assertSame(0.2, BailianRuntimeProvider::buildChatRequest('qwen-plus', $this->messages())['temperature']);
    }

    public function test_request_preserves_bounded_max_tokens(): void
    {
        $this->assertSame(512, BailianRuntimeProvider::buildChatRequest('qwen-plus', $this->messages(), 512)['max_tokens']);
    }

    public function test_request_rejects_empty_messages(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::buildChatRequest('qwen-plus', []);
    }

    public function test_request_rejects_unknown_message_role(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::buildChatRequest('qwen-plus', [['role' => 'developer', 'content' => 'x']]);
    }

    public function test_request_rejects_empty_message_content(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::buildChatRequest('qwen-plus', [['role' => 'user', 'content' => '']]);
    }

    public function test_request_rejects_zero_max_tokens(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::buildChatRequest('qwen-plus', $this->messages(), 0);
    }

    public function test_request_rejects_excessive_max_tokens(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::buildChatRequest('qwen-plus', $this->messages(), 1000001);
    }

    public function test_request_rejects_negative_temperature(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::buildChatRequest('qwen-plus', $this->messages(), 256, -0.1);
    }

    public function test_valid_response_extracts_content(): void
    {
        $this->assertSame('OK', BailianRuntimeProvider::validateChatResponse($this->response())['content']);
    }

    public function test_valid_response_extracts_finish_reason(): void
    {
        $this->assertSame('stop', BailianRuntimeProvider::validateChatResponse($this->response())['finishReason']);
    }

    public function test_valid_response_extracts_usage(): void
    {
        $this->assertSame(4, BailianRuntimeProvider::validateChatResponse($this->response())['usage']['total_tokens']);
    }

    public function test_valid_response_extracts_bounded_request_id(): void
    {
        $this->assertSame('chatcmpl_fake_1', BailianRuntimeProvider::validateChatResponse($this->response())['requestId']);
    }

    public function test_response_allows_null_finish_reason(): void
    {
        $this->assertNull(BailianRuntimeProvider::validateChatResponse($this->response(['choices' => [[ 'finish_reason' => null ]]]))['finishReason']);
    }

    public function test_response_rejects_empty_choices(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::validateChatResponse(['choices' => []]);
    }

    public function test_response_rejects_missing_message_content(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::validateChatResponse($this->response(['choices' => [[ 'message' => [] ]]]));
    }

    public function test_response_rejects_empty_content(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::validateChatResponse($this->response(['choices' => [[ 'message' => ['content' => ''] ]]]));
    }

    public function test_response_rejects_oversized_content(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::validateChatResponse($this->response(['choices' => [[ 'message' => ['content' => str_repeat('x', 200001) ]]] ]));
    }

    public function test_response_rejects_sse_done_marker(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::validateChatResponse($this->response(['choices' => [[ 'message' => ['content' => 'data: [DONE]' ]]] ]));
    }

    public function test_response_rejects_invalid_finish_reason(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::validateChatResponse($this->response(['choices' => [[ 'finish_reason' => ['stop'] ]]]));
    }

    public function test_response_rejects_negative_usage(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::validateChatResponse($this->response(['usage' => ['prompt_tokens' => -1, 'completion_tokens' => 1, 'total_tokens' => 0]]));
    }

    public function test_response_rejects_float_usage(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::validateChatResponse($this->response(['usage' => ['prompt_tokens' => 1.5, 'completion_tokens' => 1, 'total_tokens' => 2]]));
    }

    public function test_response_rejects_string_usage(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::validateChatResponse($this->response(['usage' => ['prompt_tokens' => '1', 'completion_tokens' => 1, 'total_tokens' => 2]]));
    }

    public function test_response_rejects_malformed_usage_container(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::validateChatResponse($this->response(['usage' => 'bad']));
    }

    public function test_response_rejects_invalid_request_id_characters(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::validateChatResponse($this->response(['id' => 'request id']));
    }

    public function test_response_rejects_oversized_request_id(): void
    {
        $this->expectException(InvalidArgumentException::class);
        BailianRuntimeProvider::validateChatResponse($this->response(['id' => str_repeat('x', 201)]));
    }

    public function test_non_json_failure_is_classified(): void
    {
        $this->assertSame('unauthorized', BailianRuntimeProvider::classifyHttpFailure(401));
    }

    public function test_forbidden_failure_is_classified(): void
    {
        $this->assertSame('forbidden', BailianRuntimeProvider::classifyHttpFailure(403));
    }

    public function test_rate_limit_failure_is_classified(): void
    {
        $this->assertSame('rate_limited', BailianRuntimeProvider::classifyHttpFailure(429));
    }

    public function test_server_failure_is_classified(): void
    {
        $this->assertSame('provider_5xx', BailianRuntimeProvider::classifyHttpFailure(503));
    }

    public function test_bad_request_failure_is_classified(): void
    {
        $this->assertSame('invalid_configuration', BailianRuntimeProvider::classifyHttpFailure(400));
    }

    public function test_401_is_not_retried(): void
    {
        $this->assertFalse(BailianRuntimeProvider::shouldRetry('unauthorized', 1));
    }

    public function test_403_is_not_retried(): void
    {
        $this->assertFalse(BailianRuntimeProvider::shouldRetry('forbidden', 1));
    }

    public function test_malformed_request_is_not_retried(): void
    {
        $this->assertFalse(BailianRuntimeProvider::shouldRetry('invalid_configuration', 1));
    }

    public function test_rate_limit_has_bounded_retry(): void
    {
        $this->assertTrue(BailianRuntimeProvider::shouldRetry('rate_limited', 1, 2));
        $this->assertFalse(BailianRuntimeProvider::shouldRetry('rate_limited', 3, 2));
    }

    public function test_server_failure_has_bounded_retry(): void
    {
        $this->assertTrue(BailianRuntimeProvider::shouldRetry('provider_5xx', 2, 2));
        $this->assertFalse(BailianRuntimeProvider::shouldRetry('provider_5xx', 3, 2));
    }

    public function test_timeout_has_bounded_retry(): void
    {
        $this->assertTrue(BailianRuntimeProvider::shouldRetry('timeout', 1, 3));
    }

    public function test_network_failure_has_bounded_retry(): void
    {
        $this->assertTrue(BailianRuntimeProvider::shouldRetry('network_failure', 1, 2));
    }

    public function test_retry_limit_is_capped(): void
    {
        $this->assertFalse(BailianRuntimeProvider::shouldRetry('timeout', 1, 4));
    }

    public function test_redaction_removes_fake_key(): void
    {
        $this->assertStringNotContainsString('fake-key-not-real', BailianRuntimeProvider::redactProviderError('failed fake-key-not-real', 'fake-key-not-real'));
    }

    public function test_redaction_removes_bearer_header(): void
    {
        $this->assertStringNotContainsString('Bearer fake-secret-value', BailianRuntimeProvider::redactProviderError('Authorization: Bearer fake-secret-value'));
    }

    public function test_redaction_removes_secret_like_token(): void
    {
        $this->assertStringNotContainsString('sk-fake-secret-value', BailianRuntimeProvider::redactProviderError('sk-fake-secret-value'));
    }

    public function test_redaction_removes_control_characters(): void
    {
        $this->assertSame('bad value', BailianRuntimeProvider::redactProviderError("bad\nvalue"));
    }

    public function test_redaction_is_bounded(): void
    {
        $this->assertLessThanOrEqual(500, strlen(BailianRuntimeProvider::redactProviderError(str_repeat('x', 1000))));
    }

    public function test_provenance_contains_provider(): void
    {
        $configuration = BailianRuntimeProvider::assertAllowedConfiguration($this->china(), 'qwen-plus');
        $provenance = BailianRuntimeProvider::buildProvenance($configuration, 'req-1', 'stop', ['prompt_tokens' => 1, 'completion_tokens' => 2, 'total_tokens' => 3], '2026-08-26T00:00:00.000Z', 200);
        $this->assertSame('bailian', $provenance['provider']);
    }

    public function test_provenance_contains_region_and_model(): void
    {
        $configuration = BailianRuntimeProvider::assertAllowedConfiguration($this->workspace('ap-southeast-1'), 'qwen3.5-plus');
        $provenance = BailianRuntimeProvider::buildProvenance($configuration, null, null, ['prompt_tokens' => 0, 'completion_tokens' => 0, 'total_tokens' => 0], '2026-08-26T00:00:00Z', 200);
        $this->assertSame('singapore', $provenance['region']);
        $this->assertSame('qwen3.5-plus', $provenance['modelId']);
    }

    public function test_provenance_contains_canonical_host_without_key(): void
    {
        $configuration = BailianRuntimeProvider::assertAllowedConfiguration($this->us(), 'qwen-plus');
        $provenance = BailianRuntimeProvider::buildProvenance($configuration, null, 'stop', ['prompt_tokens' => 1, 'completion_tokens' => 1, 'total_tokens' => 2], '2026-08-26T00:00:00Z', 200);
        $this->assertSame('dashscope-us.aliyuncs.com', $provenance['canonicalBaseHost']);
        $this->assertArrayNotHasKey('apiKey', $provenance);
    }

    public function test_provenance_contains_usage_and_response_status(): void
    {
        $configuration = BailianRuntimeProvider::assertAllowedConfiguration($this->china(), 'qwen-plus');
        $provenance = BailianRuntimeProvider::buildProvenance($configuration, 'req-1', 'stop', ['prompt_tokens' => 1, 'completion_tokens' => 2, 'total_tokens' => 3], '2026-08-26T00:00:00Z', 200);
        $this->assertSame(3, $provenance['usage']['total_tokens']);
        $this->assertSame(200, $provenance['responseStatus']);
    }

    public function test_provenance_rejects_invalid_timestamp(): void
    {
        $this->expectException(InvalidArgumentException::class);
        $configuration = BailianRuntimeProvider::assertAllowedConfiguration($this->china(), 'qwen-plus');
        BailianRuntimeProvider::buildProvenance($configuration, null, null, ['prompt_tokens' => 0, 'completion_tokens' => 0, 'total_tokens' => 0], 'not-a-timestamp', 200);
    }

    public function test_provenance_rejects_negative_usage(): void
    {
        $this->expectException(InvalidArgumentException::class);
        $configuration = BailianRuntimeProvider::assertAllowedConfiguration($this->china(), 'qwen-plus');
        BailianRuntimeProvider::buildProvenance($configuration, null, null, ['prompt_tokens' => -1, 'completion_tokens' => 0, 'total_tokens' => 0], '2026-08-26T00:00:00Z', 200);
    }

    public function test_provenance_rejects_invalid_response_status(): void
    {
        $this->expectException(InvalidArgumentException::class);
        $configuration = BailianRuntimeProvider::assertAllowedConfiguration($this->china(), 'qwen-plus');
        BailianRuntimeProvider::buildProvenance($configuration, null, null, ['prompt_tokens' => 0, 'completion_tokens' => 0, 'total_tokens' => 0], '2026-08-26T00:00:00Z', 99);
    }

    public function test_provenance_rejects_invalid_fallback_status(): void
    {
        $this->expectException(InvalidArgumentException::class);
        $configuration = BailianRuntimeProvider::assertAllowedConfiguration($this->china(), 'qwen-plus');
        BailianRuntimeProvider::buildProvenance($configuration, null, null, ['prompt_tokens' => 0, 'completion_tokens' => 0, 'total_tokens' => 0], '2026-08-26T00:00:00Z', 200, 'unexpected');
    }

    public function test_encrypted_credential_round_trip_uses_existing_crypto_boundary(): void
    {
        Config::set('geoflow.api_key_crypto_roots', ['synthetic-test-root-not-a-real-secret']);
        $crypto = app(ApiKeyCrypto::class);
        $stored = $crypto->encrypt('fake-key-not-real');
        $this->assertStringStartsWith('enc:v1:', $stored);
        $this->assertSame('fake-key-not-real', $crypto->decrypt($stored));
        $this->assertStringNotContainsString('fake-key-not-real', $stored);
    }

    public function test_blank_credential_is_not_accepted_by_crypto_as_new_secret(): void
    {
        $this->assertSame('', (new ApiKeyCrypto)->encrypt('   '));
    }

    public function test_provider_has_no_network_method(): void
    {
        $this->assertFalse(method_exists(BailianRuntimeProvider::class, 'post'));
        $this->assertFalse(method_exists(BailianRuntimeProvider::class, 'request'));
    }

    public function test_provider_mode_is_openai_compatible(): void
    {
        $this->assertSame('openai-compatible', BailianRuntimeProvider::PROVIDER_MODE);
    }

    public function test_provider_name_is_bailian(): void
    {
        $this->assertSame('bailian', BailianRuntimeProvider::PROVIDER);
    }
}
