import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

type Env = {
	RAG_BUCKET: R2Bucket;
	SYNC_WORKFLOW: Workflow;
	COSENSE_SID: string;
	PROJECT_NAME: string;
	ASSET: Fetcher;
	AI: Ai;
	AI_SEARCH_ID: string;
};

export class CosenseSyncWorkflow extends WorkflowEntrypoint<Env> {
	async run(event: WorkflowEvent<any>, step: WorkflowStep) {
		const projectName = this.env.PROJECT_NAME;

		await step.do('sync-all-pages-to-r2', async () => {
			let skip = 0;
			const limit = 100;
			let totalCount = 1;

			while (skip < totalCount) {
				const listUrl = `https://scrapbox.io/api/pages/${projectName}?skip=${skip}&limit=${limit}`;
				const res = await fetch(listUrl, {
					headers: { Cookie: `connect.sid=${this.env.COSENSE_SID}` },
				});

				if (!res.ok) throw new Error(`List API Error: ${res.statusText}`);
				const data = (await res.json()) as any;
				totalCount = data.count;

				await Promise.all(
					data.pages.map(async (p: any) => {
						try {
							const pageRes = await fetch(`https://scrapbox.io/api/pages/${projectName}/${encodeURIComponent(p.title)}`, {
								headers: { Cookie: `connect.sid=${this.env.COSENSE_SID}` },
							});
							if (!pageRes.ok) return;

							const pageDetail = (await pageRes.json()) as any;
							const safeTitle = p.title.replace(/[\\/?%*:|"<> \s]/g, '_').replace('\/', '%2F');

							// MDXの中身を作成
							const frontMatter = [
								'---',
								`title: "${p.title.replace(/"/g, '\\"').replace('\/', '%2F')}"`,
								`link: "https://scrapbox.io/${projectName}/${encodeURIComponent(p.title)}"`,
								`created: "${new Date(p.created * 1000).toISOString()}"`,
								`updated: "${new Date(p.updated * 1000).toISOString()}"`,
								`views: ${p.views}`,
								'---',
							].join('\n');

							const content = pageDetail.lines.map((l: any) => l.text).join('\n');

							await this.env.RAG_BUCKET.put(`mdx/${safeTitle}.mdx`, frontMatter + '\n\n' + content);
						} catch (e) {
							console.error(`Failed to process page: ${p.title}`, e);
						}
					}),
				);

				skip += data.pages.length;
				console.log(`Progress: ${skip} / ${totalCount}`);
			}

			return { msg: `Successfully synced ${skip} pages.` };
		});
	}
}

export default {
	async scheduled(event: ScheduledEvent, env: Env) {
		await env.SYNC_WORKFLOW.create();
	},
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);
		if (url.pathname === '/api/ask') {
			const url = new URL(request.url);
			const question = url.searchParams.get('q');
			if (!question) {
				return new Response('Missing "q" query parameter', { status: 400 });
			}

			const answer = await env.AI.autorag(env.AI_SEARCH_ID).aiSearch({
				query: question,
				stream: false,
				max_num_results: 5 ,
				system_prompt: `# これらのルールを守って、ユーザーの質問に回答しましょう。
   ## 大前提（違反したら失敗）
   - 収集済みデータ外の知識の混入は禁止

   ## 情報不足した場合
   - もし渡されたデータからは完全に回答できることができない或いは断片的なデータの場合はそのように回答してください。

   ## 出力フォーマット（厳守）

   ### 回答
   収集済みデータの情報を統合して回答してください。各主張の直後に引用元を明確に示してください。

   **回答の構造：**
   1. まず簡潔な要約や結論を述べる
   2. 各主張や事実の直後に、その根拠となる引用とリンクを配置
   3. 複数の情報源がある場合は、それぞれを明確に区別
   4. gyazoリンクや画像があれば、適切に引用して説明に活用

   ### 情報の限界
   収集済みデータ内に書かれていない点や確認できなかった点を明記してください。`,
			});

			const quotes = answer.data
				.map((chunk) => {
					const pageTitle = chunk.filename.split('/').slice(-1)[0].replace('.mdx', '');
					return `- [${pageTitle}](https://scrapbox.io/${env.PROJECT_NAME}/${encodeURIComponent(pageTitle)})`;
				})
				.join('\n');

			if (answer.has_more && answer.next_page) {
				answer.response += answer.next_page
			}


			return new Response(
				JSON.stringify({
					answer: `${answer.response}\n\n## 引用元\n${quotes}`,
				}),
				{ status: 200, headers: { 'Content-Type': 'text/markdown' } },
			);
		}

		return env.ASSET.fetch(request, {
			headers: {
				'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline';",
				'Set-Cookie': `projectName=${env.PROJECT_NAME}; Path=/; SameSite=Lax`,
				...request.headers
			},
		});
	},
};
