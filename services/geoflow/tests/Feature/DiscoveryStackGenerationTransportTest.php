<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\AiModel;
use App\Models\Article;
use App\Models\Author;
use App\Models\Category;
use App\Models\Task;
use App\Models\Title;
use App\Models\TitleLibrary;
use App\Services\GeoFlow\DiscoveryStackGenerationPayload;
use App\Services\GeoFlow\JobQueueService;
use App\Support\GeoFlow\ApiKeyCrypto;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

final class DiscoveryStackGenerationTransportTest extends TestCase
{
    use RefreshDatabase;

    public function test_canonical_payload_survives_real_enqueue_worker_job_and_article_routes(): void
    {
        Http::fake([
            'https://ai.test/v1/chat/completions' => Http::response([
                'model' => 'qwen-test-model',
                'choices' => [[
                    'index' => 0,
                    'message' => [
                        'role' => 'assistant',
                        'content' => "# DS Candidate\n\nApproved fact [E1].",
                    ],
                    'finish_reason' => 'stop',
                ]],
                'usage' => ['prompt_tokens' => 20, 'completion_tokens' => 10, 'total_tokens' => 30],
            ]),
        ]);

        [$task, $payload] = $this->seedDiscoveryStackTaskAndPayload();
        $admin = $this->createActiveAdmin();
        $token = $admin->createToken('discoverystack-transport-test', [
            'tasks:write',
            'jobs:read',
            'articles:read',
        ])->plainTextToken;

        $requestId = 'ds-interoperability-request-1';
        $response = $this->withHeaders([
            'Authorization' => 'Bearer '.$token,
            'X-Request-Id' => $requestId,
            'X-Idempotency-Key' => $payload['idempotency_key'],
        ])->postJson('/api/v1/tasks/'.$task->id.'/enqueue', [
            ...$payload,
            'job_type' => DiscoveryStackGenerationPayload::JOB_TYPE,
        ]);

        $response->assertCreated()
            ->assertJsonPath('success', true)
            ->assertJsonPath('meta.request_id', $requestId)
            ->assertJsonPath('data.task_id', (int) $task->id)
            ->assertJsonPath('data.job_id', fn (mixed $value): bool => (int) $value > 0)
            ->assertJsonPath('data.status', 'pending');

        $jobId = (int) $response->json('data.job_id');
        $job = $this->withHeaders([
            'Authorization' => 'Bearer '.$token,
            'X-Request-Id' => 'ds-interoperability-job-read',
        ])->getJson('/api/v1/jobs/'.$jobId);

        $job->assertOk()
            ->assertJsonPath('success', true)
            ->assertJsonPath('meta.request_id', 'ds-interoperability-job-read')
            ->assertJsonPath('data.id', $jobId)
            ->assertJsonPath('data.task_id', (int) $task->id)
            ->assertJsonPath('data.job_type', DiscoveryStackGenerationPayload::JOB_TYPE)
            ->assertJsonPath('data.payload.request_id', $payload['request_id'])
            ->assertJsonPath('data.payload.evidence_chunks.0.reviewed_text', 'Approved fact text.')
            ->assertJsonPath('data.payload.selected_rule_ids.0', 'direct-answer-first')
            ->assertJsonMissingPath('data.payload.job_type')
            ->assertJsonPath('data.task_run_summary.status', 'completed')
            ->assertJsonPath('data.task_run_summary.article_id', fn (mixed $value): bool => (int) $value > 0)
            ->assertJsonPath('data.task_run_summary.meta.result.discoverystack_generation_v1.request_id', $payload['request_id'])
            ->assertJsonPath('data.task_run_summary.meta.result.discoverystack_generation_v1.request_fingerprint', $payload['request_fingerprint'])
            ->assertJsonPath('data.task_run_summary.meta.result.discoverystack_generation_v1.brief_fingerprint', $payload['brief_fingerprint'])
            ->assertJsonPath('data.task_run_summary.meta.result.discoverystack_generation_v1.evidence_snapshot_hash', $payload['evidence_snapshot_hash'])
            ->assertJsonPath('data.task_run_summary.meta.result.discoverystack_generation_v1.external_article_key', $payload['external_article_key'])
            ->assertJsonPath('data.task_run_summary.meta.result.discoverystack_generation_v1.content_hash', hash('sha256', "# DS Candidate\n\nApproved fact [E1]."))
            ->assertJsonPath('data.task_run_summary.meta.result.discoverystack_generation_v1.applied_rule_ids.0', 'direct-answer-first')
            ->assertJsonPath('data.task_run_summary.meta.result.discoverystack_generation_v1.citation_bindings.0.marker', '[E1]')
            ->assertJsonPath('data.task_run_summary.meta.result.discoverystack_generation_v1.provider_provenance.mode', 'provider');

        $articleId = (int) $job->json('data.task_run_summary.article_id');
        $article = $this->withHeaders([
            'Authorization' => 'Bearer '.$token,
            'X-Request-Id' => 'ds-interoperability-article-read',
        ])->getJson('/api/v1/articles/'.$articleId);

        $article->assertOk()
            ->assertJsonPath('success', true)
            ->assertJsonPath('meta.request_id', 'ds-interoperability-article-read')
            ->assertJsonPath('data.id', $articleId)
            ->assertJsonPath('data.task_id', (int) $task->id)
            ->assertJsonPath('data.status', 'draft')
            ->assertJsonPath('data.review_status', 'pending')
            ->assertJsonPath('data.title', $payload['brief']['title'])
            ->assertJsonPath('data.content', "# DS Candidate\n\nApproved fact [E1].");
        $this->assertArrayNotHasKey('provider_provenance', $article->json('data'));
        $this->assertArrayNotHasKey('request_fingerprint', $article->json('data'));
        $this->assertSame(0, $this->app['db']->table('article_distributions')->count());
        Http::assertSentCount(1);
        Http::assertSent(fn ($request): bool => $request->url() === 'https://ai.test/v1/chat/completions'
            && str_contains((string) $request->body(), 'APPROVED EVIDENCE DATA')
            && str_contains((string) $request->body(), 'direct-answer-first')
            && str_contains((string) $request->body(), '<BEGIN_INERT_EVIDENCE_DATA>'));
    }

    public function test_scope_boundary_and_strict_payload_rejection_are_enforced_before_worker_side_effects(): void
    {
        Http::fake();
        [$task, $payload] = $this->seedDiscoveryStackTaskAndPayload();
        $admin = $this->createActiveAdmin('scope-admin');
        $readOnlyToken = $admin->createToken('jobs-only', ['jobs:read'])->plainTextToken;

        $this->withHeaders(['Authorization' => 'Bearer '.$readOnlyToken])
            ->postJson('/api/v1/tasks/'.$task->id.'/enqueue', [
                ...$payload,
                'job_type' => DiscoveryStackGenerationPayload::JOB_TYPE,
            ])
            ->assertForbidden()
            ->assertJsonPath('error.code', 'forbidden');

        $runsBefore = (int) $this->app['db']->table('task_runs')->count();
        $writeToken = $admin->createToken('writer', ['tasks:write'])->plainTextToken;
        $invalid = [...$payload, 'unexpected_field' => 'reject-me'];
        $this->withHeaders([
            'Authorization' => 'Bearer '.$writeToken,
            'X-Request-Id' => 'ds-invalid-payload',
            'X-Idempotency-Key' => $payload['idempotency_key'],
        ])->postJson('/api/v1/tasks/'.$task->id.'/enqueue', [
            ...$invalid,
            'job_type' => DiscoveryStackGenerationPayload::JOB_TYPE,
        ])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'discoverystack_payload_invalid');
        $this->assertSame($runsBefore, (int) $this->app['db']->table('task_runs')->count());
        Http::assertNothingSent();
    }

    public function test_same_idempotency_key_replays_the_original_enqueue_without_a_second_job(): void
    {
        $this->fakeProvider("# Replay Candidate\n\nApproved fact [E1].");
        [$task, $payload] = $this->seedDiscoveryStackTaskAndPayload();
        $token = $this->createActiveAdmin('replay-admin')->createToken('replay', ['tasks:write'])->plainTextToken;

        $first = $this->enqueueDiscovery($task, $payload, $token, 'ds-replay-request-1');
        $second = $this->enqueueDiscovery($task, $payload, $token, 'ds-replay-request-2');

        $first->assertCreated();
        $second->assertCreated();
        $this->assertSame($first->json('data.job_id'), $second->json('data.job_id'));
        $this->assertSame(1, (int) $this->app['db']->table('task_runs')->count());
    }

    public function test_different_payload_with_same_idempotency_key_is_rejected_before_a_second_job(): void
    {
        $this->fakeProvider("# Collision Candidate\n\nApproved fact [E1].");
        [$task, $payload] = $this->seedDiscoveryStackTaskAndPayload();
        $token = $this->createActiveAdmin('collision-admin')->createToken('collision', ['tasks:write'])->plainTextToken;

        $this->enqueueDiscovery($task, $payload, $token, 'ds-collision-request-1')->assertCreated();
        $changed = $payload;
        $changed['brief']['title'] = 'Different body with the same key';
        $this->enqueueDiscovery($task, $changed, $token, 'ds-collision-request-2')
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'idempotency_conflict');
        $this->assertSame(1, (int) $this->app['db']->table('task_runs')->count());
        $this->assertSame(1, (int) Article::query()->where('task_id', $task->id)->count());
    }

    public function test_tampered_evidence_chunk_hash_is_rejected_before_persistence(): void
    {
        Http::fake();
        [$task, $payload] = $this->seedDiscoveryStackTaskAndPayload();
        $payload['evidence_chunks'][0]['chunk_hash'] = str_repeat('0', 64);
        $token = $this->createActiveAdmin('evidence-admin')->createToken('evidence', ['tasks:write'])->plainTextToken;

        $this->enqueueDiscovery($task, $payload, $token, 'ds-evidence-request')
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'discoverystack_payload_invalid');
        $this->assertSame(0, (int) $this->app['db']->table('task_runs')->count());
        Http::assertNothingSent();
    }

    public function test_stale_request_fingerprint_is_rejected_before_persistence(): void
    {
        Http::fake();
        [$task, $payload] = $this->seedDiscoveryStackTaskAndPayload();
        $payload['request_fingerprint'] = str_repeat('0', 64);
        $token = $this->createActiveAdmin('fingerprint-admin')->createToken('fingerprint', ['tasks:write'])->plainTextToken;

        $this->enqueueDiscovery($task, $payload, $token, 'ds-stale-request')
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'discoverystack_payload_invalid');
        $this->assertSame(0, (int) $this->app['db']->table('task_runs')->count());
        Http::assertNothingSent();
    }

    public function test_unknown_evidence_citation_fails_closed_without_false_completed_metadata(): void
    {
        $this->fakeProvider("# Unsafe Candidate\n\nUnsupported claim [E9].");
        [$task, $payload] = $this->seedDiscoveryStackTaskAndPayload();
        $token = $this->createActiveAdmin('citation-admin')->createToken('citation', ['tasks:write', 'jobs:read'])->plainTextToken;

        $response = $this->enqueueDiscovery($task, $payload, $token, 'ds-citation-request');
        $response->assertCreated();
        $run = $this->app['db']->table('task_runs')->where('id', $response->json('data.job_id'))->first();
        $this->assertNotNull($run);
        $this->assertContains($run->status, ['pending', 'failed']);
        $this->assertNotSame('completed', $run->status);
        $meta = json_decode((string) $run->meta, true);
        $this->assertIsArray($meta);
        $this->assertArrayNotHasKey('result', $meta);
        $this->assertSame(0, (int) Article::query()->where('task_id', $task->id)->count());
    }

    public function test_duplicate_enqueue_with_queued_work_produces_one_task_run_and_no_duplicate_article(): void
    {
        Queue::fake();
        [$task, $payload] = $this->seedDiscoveryStackTaskAndPayload();
        $token = $this->createActiveAdmin('duplicate-admin')->createToken('duplicate', ['tasks:write'])->plainTextToken;

        $first = $this->enqueueDiscovery($task, $payload, $token, 'ds-duplicate-request-1');
        $second = $this->enqueueDiscovery($task, $payload, $token, 'ds-duplicate-request-2');

        $first->assertCreated();
        $second->assertCreated();
        $this->assertSame($first->json('data.job_id'), $second->json('data.job_id'));
        $this->assertSame(1, (int) $this->app['db']->table('task_runs')->count());
        $this->assertNull(app(JobQueueService::class)->enqueueTaskJob($task->id, DiscoveryStackGenerationPayload::JOB_TYPE, $payload));
        $this->assertSame(1, (int) $this->app['db']->table('task_runs')->count());
        $this->assertSame(0, (int) Article::query()->where('task_id', $task->id)->count());
    }

    public function test_legacy_generate_article_still_uses_the_legacy_worker_path(): void
    {
        $this->fakeProvider("# Legacy Article\n\nLegacy body.");
        [$task, $title] = $this->seedLegacyTask();
        $token = $this->createActiveAdmin('legacy-admin')->createToken('legacy', ['tasks:write'])->plainTextToken;

        $response = $this->withHeaders([
            'Authorization' => 'Bearer '.$token,
            'X-Request-Id' => 'legacy-request',
            'X-Idempotency-Key' => 'legacy-idempotency',
        ])->postJson('/api/v1/tasks/'.$task->id.'/enqueue', [
            'job_type' => 'generate_article',
        ]);

        $response->assertCreated()->assertJsonPath('data.task_id', (int) $task->id);
        $article = Article::query()->where('task_id', $task->id)->firstOrFail();
        $this->assertSame($title->title, $article->title);
        $this->assertSame('draft', $article->status);
        $this->assertSame('pending', $article->review_status);
    }

    public function test_discoverystack_job_does_not_publish_a_due_approved_draft(): void
    {
        $this->fakeProvider("# DS Due Candidate\n\nApproved fact [E1].");
        [$task, $payload] = $this->seedDiscoveryStackTaskAndPayload();
        $categoryId = (int) Category::query()->value('id');
        $authorId = $this->createTestAuthor('Existing approved author');
        $existing = Article::query()->create([
            'title' => 'Existing approved draft',
            'slug' => 'existing-approved-'.uniqid(),
            'content' => 'Existing content',
            'excerpt' => 'Existing excerpt',
            'keywords' => '',
            'meta_description' => '',
            'task_id' => $task->id,
            'category_id' => $categoryId,
            'author_id' => $authorId,
            'status' => 'draft',
            'review_status' => 'approved',
            'is_ai_generated' => 0,
            'published_at' => null,
        ]);
        $task->update(['next_publish_at' => now()->subMinute()]);
        $token = $this->createActiveAdmin('no-publish-admin')->createToken('no-publish', ['tasks:write'])->plainTextToken;

        $this->enqueueDiscovery($task, $payload, $token, 'ds-no-publish-request')->assertCreated();
        $this->assertSame('draft', $existing->fresh()->status);
        $this->assertSame('approved', $existing->fresh()->review_status);
        $this->assertSame(0, (int) $task->fresh()->published_count);
        $this->assertSame(0, (int) $this->app['db']->table('article_distributions')->count());
    }

    public function test_blocked_generation_does_not_create_an_article(): void
    {
        $this->fakeProvider("# Blocked Candidate\n\nApproved fact [E1].");
        [$task, $payload] = $this->seedDiscoveryStackTaskAndPayload();
        $categoryId = (int) Category::query()->value('id');
        $authorId = $this->createTestAuthor('Existing pending author');
        Article::query()->create([
            'title' => 'Draft pool full',
            'slug' => 'draft-pool-full-'.uniqid(),
            'content' => 'Existing draft',
            'excerpt' => 'Existing draft',
            'keywords' => '',
            'meta_description' => '',
            'task_id' => $task->id,
            'category_id' => $categoryId,
            'author_id' => $authorId,
            'status' => 'draft',
            'review_status' => 'pending',
            'is_ai_generated' => 0,
            'published_at' => null,
        ]);
        $task->update(['draft_limit' => 1]);
        $token = $this->createActiveAdmin('blocked-admin')->createToken('blocked', ['tasks:write'])->plainTextToken;

        $response = $this->enqueueDiscovery($task, $payload, $token, 'ds-blocked-request');
        $response->assertCreated();
        $this->assertSame(1, (int) Article::query()->where('task_id', $task->id)->count());
        $this->assertSame(0, (int) $this->app['db']->table('article_distributions')->count());
    }

    public function test_provider_failure_does_not_leave_a_false_completed_generation_result(): void
    {
        Http::fake([
            'https://ai.test/v1/chat/completions' => Http::response(['error' => ['message' => 'provider unavailable']], 503),
        ]);
        [$task, $payload] = $this->seedDiscoveryStackTaskAndPayload();
        $token = $this->createActiveAdmin('provider-failure-admin')->createToken('provider-failure', ['tasks:write'])->plainTextToken;

        $response = $this->enqueueDiscovery($task, $payload, $token, 'ds-provider-failure');
        $response->assertCreated();
        $run = $this->app['db']->table('task_runs')->where('id', $response->json('data.job_id'))->first();
        $this->assertNotNull($run);
        $this->assertContains($run->status, ['pending', 'failed']);
        $this->assertNotSame('completed', $run->status);
        $meta = json_decode((string) $run->meta, true);
        $this->assertIsArray($meta);
        $this->assertArrayHasKey('payload', $meta);
        $this->assertArrayNotHasKey('result', $meta);
        $this->assertSame(0, (int) Article::query()->where('task_id', $task->id)->count());
    }

    private function createTestAuthor(string $name): int
    {
        return (int) Author::query()->create(['name' => $name, 'bio' => 'Test author'])->id;
    }

    private function fakeProvider(string $content): void
    {
        Http::fake([
            'https://ai.test/v1/chat/completions' => Http::response([
                'model' => 'qwen-test-model',
                'choices' => [[
                    'index' => 0,
                    'message' => ['role' => 'assistant', 'content' => $content],
                    'finish_reason' => 'stop',
                ]],
                'usage' => ['prompt_tokens' => 20, 'completion_tokens' => 10, 'total_tokens' => 30],
            ]),
        ]);
    }

    private function enqueueDiscovery(Task $task, array $payload, string $token, string $requestId): TestResponse
    {
        return $this->withHeaders([
            'Authorization' => 'Bearer '.$token,
            'X-Request-Id' => $requestId,
            'X-Idempotency-Key' => $payload['idempotency_key'],
        ])->postJson('/api/v1/tasks/'.$task->id.'/enqueue', [
            ...$payload,
            'job_type' => DiscoveryStackGenerationPayload::JOB_TYPE,
        ]);
    }

    /** @return array{0:Task,1:Title} */
    private function seedLegacyTask(): array
    {
        $this->app['config']->set('geoflow.api_key_crypto_roots', ['test-only-discoverystack-root']);
        Category::query()->create([
            'name' => 'Legacy Test',
            'slug' => 'legacy-test-'.uniqid(),
            'sort_order' => 1,
        ]);
        $model = AiModel::query()->create([
            'name' => 'Legacy configured model',
            'version' => 'test',
            'api_key' => app(ApiKeyCrypto::class)->encrypt('test-api-key'),
            'model_id' => 'legacy-test-model',
            'model_type' => 'chat',
            'api_url' => 'https://ai.test',
            'daily_limit' => 10,
            'status' => 'active',
        ]);
        $library = TitleLibrary::query()->create(['name' => 'Legacy title library']);
        $title = Title::query()->create([
            'library_id' => $library->id,
            'title' => 'Legacy selected title',
            'keyword' => 'legacy-keyword',
        ]);
        $task = Task::query()->create([
            'name' => 'Legacy worker task',
            'title_library_id' => $library->id,
            'ai_model_id' => $model->id,
            'draft_limit' => 10,
            'article_limit' => 10,
            'need_review' => 1,
            'status' => 'active',
            'schedule_enabled' => 1,
        ]);

        return [$task, $title];
    }

    /** @return array{0:Task,1:array<string,mixed>} */
    private function seedDiscoveryStackTaskAndPayload(): array
    {
        $this->app['config']->set('geoflow.api_key_crypto_roots', ['test-only-discoverystack-root']);

        $category = Category::query()->create([
            'name' => 'DiscoveryStack Test',
            'slug' => 'discoverystack-test-'.uniqid(),
            'sort_order' => 1,
        ]);
        $model = AiModel::query()->create([
            'name' => 'Configured DS model',
            'version' => 'test',
            'api_key' => app(ApiKeyCrypto::class)->encrypt('test-api-key'),
            'model_id' => 'qwen-test-model',
            'model_type' => 'chat',
            'api_url' => 'https://ai.test',
            'daily_limit' => 10,
            'status' => 'active',
        ]);
        $task = Task::query()->create([
            'name' => 'DiscoveryStack transport task',
            'ai_model_id' => $model->id,
            'status' => 'active',
            'schedule_enabled' => 1,
            'need_review' => 1,
            'article_limit' => 10,
            'draft_limit' => 10,
        ]);

        $reviewedText = 'Approved fact text.';
        $brief = [
            'title' => 'DiscoveryStack candidate',
            'audience' => 'Reviewers',
            'goals' => ['Answer the brief directly'],
            'constraints' => ['Use approved facts only'],
        ];
        $evidence = [[
            'source_id' => 'source-1',
            'artifact_id' => 'artifact-1',
            'chunk_id' => 'chunk-1',
            'chunk_hash' => hash('sha256', $reviewedText),
            'reviewed_text' => $reviewedText,
            'locator' => 'https://evidence.discoverystack.dev/source-1',
        ]];
        $draft = [
            'protocolVersion' => 'discoverystack-geoflow-v1',
            'requestId' => 'ds-interoperability-request-1',
            'idempotencyKey' => 'ds-interoperability-idempotency-1',
            'ownerUserId' => 7,
            'clientId' => 8,
            'calendarEntryId' => 9,
            'productionPlanId' => 10,
            'deliverableId' => 11,
            'briefId' => 12,
            'jobId' => 13,
            'evidenceSnapshotHash' => hash('sha256', 'snapshot-v1'),
            'brief' => $brief,
            'contentType' => 'article',
            'language' => 'en',
            'generationMode' => 'draft',
            'revisionContext' => null,
            'requestedCapabilities' => ['autogeo_optimization', 'human_review'],
            'selectedRuleIds' => ['direct-answer-first'],
            'authoritySourceIds' => ['source-1'],
            'evidenceChunks' => [[
                'sourceId' => 'source-1',
                'artifactId' => 'artifact-1',
                'chunkId' => 'chunk-1',
                'chunkHash' => hash('sha256', $reviewedText),
                'reviewedText' => $reviewedText,
                'locator' => 'https://evidence.discoverystack.dev/source-1',
            ]],
            'createdAt' => '2026-08-26T01:02:03.000Z',
        ];
        $briefFingerprint = hash('sha256', $this->canonicalJson([
            'title' => $brief['title'],
            'audience' => $brief['audience'],
            'contentType' => $draft['contentType'],
            'language' => $draft['language'],
            'goals' => $brief['goals'],
            'constraints' => $brief['constraints'],
        ]));
        $requestFingerprint = hash('sha256', $this->canonicalJson([...$draft, 'briefFingerprint' => $briefFingerprint]));

        return [$task, [
            'protocol_version' => 'discoverystack-geoflow-v1',
            'request_id' => $draft['requestId'],
            'request_fingerprint' => $requestFingerprint,
            'idempotency_key' => $draft['idempotencyKey'],
            'owner_user_id' => $draft['ownerUserId'],
            'client_id' => $draft['clientId'],
            'calendar_entry_id' => $draft['calendarEntryId'],
            'production_plan_id' => $draft['productionPlanId'],
            'deliverable_id' => $draft['deliverableId'],
            'brief_id' => $draft['briefId'],
            'discovery_stack_job_id' => $draft['jobId'],
            'evidence_snapshot_hash' => $draft['evidenceSnapshotHash'],
            'brief_fingerprint' => $briefFingerprint,
            'brief' => $brief,
            'content_type' => $draft['contentType'],
            'language' => $draft['language'],
            'generation_mode' => $draft['generationMode'],
            'revision_context' => null,
            'requested_capabilities' => $draft['requestedCapabilities'],
            'selected_rule_ids' => $draft['selectedRuleIds'],
            'authority_source_ids' => $draft['authoritySourceIds'],
            'evidence_chunks' => $evidence,
            'created_at' => $draft['createdAt'],
            'attempt' => 1,
            'external_article_key' => 'article-9-11',
        ]];
    }

    private function createActiveAdmin(string $username = 'ds-transport-admin'): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => 'secret-123',
            'email' => $username.'@example.test',
            'display_name' => 'DiscoveryStack Test',
            'role' => 'admin',
            'status' => 'active',
        ]);
    }

    /** @param mixed $value */
    private function canonicalJson(mixed $value): string
    {
        if (is_array($value)) {
            if (! array_is_list($value)) {
                ksort($value, SORT_STRING);
            }
            foreach ($value as $key => $child) {
                $value[$key] = $this->canonicalizeValue($child);
            }
        }

        return json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR);
    }

    /** @param mixed $value */
    private function canonicalizeValue(mixed $value): mixed
    {
        if (! is_array($value)) {
            return $value;
        }
        if (! array_is_list($value)) {
            ksort($value, SORT_STRING);
        }
        foreach ($value as $key => $child) {
            $value[$key] = $this->canonicalizeValue($child);
        }

        return $value;
    }
}
