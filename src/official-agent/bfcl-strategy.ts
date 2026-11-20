/** Editable user guidance, not a replacement for the frozen node system or official schemas. */
export const BFCL_DECISION_STRATEGY = `Complete the currently revealed BFCL conversation using only its official tools.
The initial public state, current turn, history and available function schemas are already supplied. Use the latest observation, including real successful calls and errors.
Choose a useful available function through bfcl_call when its required arguments are known. Never invent functions or required argument values. A successful status query is evidence about that status, not proof that every requested action was executed.
If an essential function is not currently available, or a required argument cannot be obtained from the public request, history or useful available functions, submit a truthful current-turn reply with bfcl_respond: explain the specific limitation or ask for the missing information. This ends the current turn, not the entire conversation. The environment may then reveal another public message or additional function schemas; react only after they are actually revealed.
Calling bfcl_state does not advance the turn or unlock functions. Do not repeatedly read an unchanged state while waiting for a missing function or argument. Read state only to recover genuinely unknown current state; after an action, consume its returned observation first.
Before choosing another action, inspect the prior executed business function names, exact arguments and paired real observations in the conversation. Do not treat each decision as a fresh start.
A raw observation such as "None" or null may be a documented void return from a state-changing function. It is not automatically a failure or a success: consult that function's public schema/description and, when genuinely uncertain, use a useful read-only verification rather than repeating the same write.
Once a lookup returns the requested information, answer the current request using that information. A pending/open/incomplete business status is a result to report truthfully, not a reason to poll indefinitely unless the public request explicitly requires waiting and there is a supported reason to expect new information.
If a business operation returns an error, use the actual error to correct the request or submit a truthful limitation. Do not retry unchanged arguments under unchanged conditions merely because the desired result was absent. Do not recreate or rewrite resources after observing the requested operation already happened.
When the current request has been handled, submit its reply through bfcl_respond as well. Final text or a done marker does not submit a turn. Do not claim unexecuted actions succeeded.`;

/** The host supplies this contract after resolving candidate messages. */
export const BFCL_ACTION_CONTRACT=`Fixed BFCL action contract. This governs the next action regardless of candidate strategy or hints.
The action must be one strict JSON object with done, tool, and arguments. SAMPLE returns it directly. In a REFLECT revision, preserve the REFLECT envelope and put the action in revisedResult.content. For a tool action, use done=false and select one of bfcl_state, bfcl_call, or bfcl_respond.
Read state: {"done":false,"tool":"bfcl_state","arguments":{}}.
Call a revealed business function through {"done":false,"tool":"bfcl_call","arguments":{"turn":0,"calls":[{"name":"available_function","arguments":{}}]}}. Use the actual current turn and function schema.
Submit a current-turn reply, including a missing function or parameter reply, through {"done":false,"tool":"bfcl_respond","arguments":{"turn":0,"message":"current-turn reply"}}. This can reveal another turn. Never combine bfcl_respond with done=true.
The session finishes when its public observation reports complete:true. Final answer text alone cannot submit a turn.`;

/** Separate host runaway guard; official per-turn business-call limits stay in the environment. */
export const BFCL_HOST_GRAPH_RUN_LIMIT = 1024;
