#!/usr/bin/env python3
"""Official AutomationBench environment only. Models and tool admission belong to Ditto."""
import argparse
import asyncio
import contextlib
import json
import os
import re
import sys
from urllib.parse import urlparse
from pathlib import Path
from functools import lru_cache

from automationbench.domains import DOMAINS
from automationbench.runner import AutomationBenchEnv
from automationbench.rubric import create_rubric, partial_credit, task_completed_correctly
from automationbench.schema.world import WorldState
from automationbench.tools.api import search as api_search_module
from automationbench.tools.api import query_engine

# Experiment-only cache relocation: the official search helper may regenerate
# index.txt based on clone mtimes. Keep the pinned source checkout immutable.
cache = Path(os.environ.get('DITTO_AUTOMATION_CACHE_DIR',
    str(Path(os.environ.get('LOCALAPPDATA', str(Path.home() / '.cache'))) / 'CodeSoul' / 'Ditto' / 'automation-cache')))
cache.mkdir(parents=True, exist_ok=True)
api_search_module.INDEX_FILE = cache / 'api-index.txt'


@lru_cache(maxsize=None)
def dataset(domain):
    return DOMAINS[domain]()


def tasks(domains=None):
    for domain in domains or DOMAINS:
        for row in dataset(domain):
            if isinstance(row['info'], str):
                row['info'] = json.loads(row['info'])
            row['domain'] = domain
            yield row


def query_recursion_observation(error, name, arguments):
    """Only the observed read-only SOQL parser depth limit is repairable input."""
    if not isinstance(error, RecursionError) or name != 'api_fetch' or arguments.get('method') != 'GET':
        return None
    if not isinstance(arguments.get('url'), str):
        return None
    endpoint = urlparse(arguments.get('url', ''))
    if not endpoint.hostname or not endpoint.hostname.endswith('.salesforce.com') or not re.fullmatch(r'/services/data/v\d+\.\d+/query', endpoint.path):
        return None
    if arguments.get('body') not in (None, 'null'):
        return None
    frames = []
    current = error.__traceback__
    while current:
        frames.append(current.tb_frame.f_code)
        current = current.tb_next
    # Parsing/validation occurs before record lookup or query execution. Do not
    # convert execute_query, serialization, bridge or arbitrary recursion faults.
    if not frames or frames[-1] is not query_engine._walk_expression.__code__ or query_engine.parse_query.__code__ not in frames or query_engine._validate_dialect.__code__ not in frames:
        return None
    return json.dumps({'error': 'MALFORMED_QUERY: query filter expression is too deeply nested; simplify the query or split it into smaller read-only queries.'})


async def serve():
    sessions = {}
    for line in sys.stdin:
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                op = request['op']
                session = request['session']
                state, env = sessions.get(session, (None, None))
                if op == 'start':
                    domain = request['taskId'].split('.')[0]
                    row = next(r for r in tasks([domain]) if r['info']['task_name'] == request['taskId'])
                    env = AutomationBenchEnv(dataset=dataset(domain), rubric=create_rubric(), toolset='api')
                    state = await env.setup_state(row)
                    sessions[session] = (state, env)
                    result = {'tools': env._all_oai_tools, 'contract': state['_task_contract_sha256']}
                elif op == 'close':
                    sessions.pop(session, None)
                    result = None
                elif state is None:
                    raise ValueError('Start a task before using its environment')
                elif op == 'call':
                    args = env.update_tool_args(request['name'], request['arguments'], [], state)
                    try:
                        output = await env.call_tool(request['name'], args, 'external')
                        result = {'content': output.content}
                    except RecursionError as error:
                        observation = query_recursion_observation(error, request['name'], request['arguments'])
                        if observation is None:
                            raise
                        result = {'content': observation}
                elif op == 'snapshot':
                    result = {'world': state['world'].model_dump(mode='json'), 'contract': state['_task_contract_sha256']}
                elif op == 'grade':
                    if request['contract'] != state['_task_contract_sha256']:
                        raise ValueError('Task contract changed')
                    state['world'] = WorldState.model_validate(request['world'])
                    credit = partial_credit(state)
                    result = {'score': int(task_completed_correctly(state)), 'partialCredit': credit,
                              'assertions': state['_assertion_results']}
                else:
                    raise ValueError('Unknown bridge operation')
            print(json.dumps({'ok': True, 'result': result}), flush=True)
        except Exception as e:
            print(json.dumps({'ok': False, 'error': str(e)}), flush=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--export')
    args = p.parse_args()
    if args.export:
        with open(args.export, 'w', encoding='utf-8') as f:
            for row in tasks():
                f.write(json.dumps(row, ensure_ascii=False) + '\n')
    else:
        asyncio.run(serve())
