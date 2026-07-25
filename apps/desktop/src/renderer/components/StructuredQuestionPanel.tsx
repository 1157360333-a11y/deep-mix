import { useEffect, useMemo, useState } from "react";
import {
  USER_INPUT_LIMITS,
  type UserInputAnswer,
  type UserInputAnswerValue,
  type UserInputQuestion,
  type UserInputRequestRecord,
} from "@deep-mix/shared-schema";
import { Icon } from "./Icons";

interface StructuredQuestionPanelProps {
  request: UserInputRequestRecord;
  busy: boolean;
  onSubmit: (answers: UserInputAnswer[]) => void;
  onCancel: () => void;
}

interface QuestionDraft {
  selected: string[];
  text: string;
  confirmation?: boolean;
  acceptDefault: boolean;
}

function emptyDraft(): QuestionDraft {
  return { selected: [], text: "", acceptDefault: false };
}

function answerFor(question: UserInputQuestion, draft: QuestionDraft | undefined): UserInputAnswer | undefined {
  if (!draft) return undefined;
  if (draft.acceptDefault && question.defaultValue !== undefined) {
    return {
      questionId: question.id,
      value: question.defaultValue,
      source: "default_accepted",
    };
  }
  if (question.kind === "confirm") {
    return draft.confirmation === undefined
      ? undefined
      : { questionId: question.id, value: draft.confirmation, source: "explicit_confirmation" };
  }
  if (question.kind === "text") {
    return draft.text.trim()
      ? { questionId: question.id, value: draft.text, source: "freeform" }
      : undefined;
  }
  if (question.kind === "single_select") {
    if (draft.selected[0]) {
      return { questionId: question.id, value: draft.selected[0], source: "selected_option" };
    }
    return question.allowFreeform && draft.text.trim()
      ? { questionId: question.id, value: draft.text.trim(), source: "freeform" }
      : undefined;
  }
  const freeform = question.allowFreeform ? draft.text.trim() : "";
  const value = [...draft.selected, ...(freeform ? [freeform] : [])];
  if (value.length === 0) return undefined;
  return {
    questionId: question.id,
    value,
    source: freeform ? "freeform" : "selected_option",
  };
}

function formatDefault(value: UserInputAnswerValue): string {
  if (Array.isArray(value)) return value.join("、");
  if (typeof value === "boolean") return value ? "是" : "否";
  return value;
}

export function StructuredQuestionPanel({
  request,
  busy,
  onSubmit,
  onCancel,
}: StructuredQuestionPanelProps) {
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});

  useEffect(() => {
    setDrafts(Object.fromEntries(request.questions.map((question) => [question.id, emptyDraft()])));
  }, [request.requestId, request.questions]);

  const answers = useMemo(
    () => request.questions
      .map((question) => answerFor(question, drafts[question.id]))
      .filter((answer): answer is UserInputAnswer => Boolean(answer)),
    [drafts, request.questions],
  );
  const answerIds = new Set(answers.map((answer) => answer.questionId));
  const answersWithinLimits = answers.every((answer) =>
    !Array.isArray(answer.value) || answer.value.length <= USER_INPUT_LIMITS.maxOptionsPerQuestion,
  );
  const canSubmit = !busy
    && answersWithinLimits
    && request.questions.every((question) => !question.required || answerIds.has(question.id));

  const updateDraft = (questionId: string, update: (current: QuestionDraft) => QuestionDraft) => {
    setDrafts((current) => ({
      ...current,
      [questionId]: update(current[questionId] ?? emptyDraft()),
    }));
  };

  return (
    <section className="structured-question" aria-label="等待用户回答">
      <div className="structured-question__heading">
        <span className="structured-question__signal"><Icon name="spark" size={16} /></span>
        <div>
          <small>{request.mode === "blocking" ? "DEEP-MIX 已暂停，等待补充信息" : "DEEP-MIX 提问，可稍后回答"}</small>
          <strong>{request.title || "请回答以下问题后继续原任务"}</strong>
        </div>
      </div>

      <div className="structured-question__list">
        {request.questions.map((question, index) => {
          const draft = drafts[question.id] ?? emptyDraft();
          return (
            <fieldset className="structured-question__item" key={question.id} disabled={busy}>
              <legend>
                <span>{index + 1}</span>
                {question.prompt}
                {!question.required && <small>可选</small>}
              </legend>

              {question.options && question.options.length > 0 && (
                <div className="structured-question__options">
                  {question.options.map((option) => {
                    const selected = draft.selected.includes(option.id);
                    return (
                      <button
                        type="button"
                        className={selected ? "is-selected" : ""}
                        aria-pressed={selected}
                        key={option.id}
                        onClick={() => updateDraft(question.id, (current) => ({
                          ...current,
                          acceptDefault: false,
                          selected: question.kind === "multi_select"
                            ? selected
                              ? current.selected.filter((id) => id !== option.id)
                              : [...current.selected, option.id]
                            : [option.id],
                        }))}
                      >
                        <span>{option.label}</span>
                        {option.description && <small>{option.description}</small>}
                      </button>
                    );
                  })}
                </div>
              )}

              {question.kind === "confirm" && (
                <div className="structured-question__options structured-question__options--confirm">
                  {[{ label: "是", value: true }, { label: "否", value: false }].map((option) => (
                    <button
                      type="button"
                      className={draft.confirmation === option.value && !draft.acceptDefault ? "is-selected" : ""}
                      aria-pressed={draft.confirmation === option.value && !draft.acceptDefault}
                      key={String(option.value)}
                      onClick={() => updateDraft(question.id, (current) => ({
                        ...current,
                        acceptDefault: false,
                        confirmation: option.value,
                      }))}
                    >
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
              )}

              {(question.kind === "text" || question.allowFreeform) && (
                <input
                  type="text"
                  value={draft.text}
                  maxLength={USER_INPUT_LIMITS.maxFreeformChars}
                  placeholder={question.placeholder || (question.kind === "text" ? "输入回答" : "也可以输入自定义回答")}
                  onChange={(event) => updateDraft(question.id, (current) => ({
                    ...current,
                    acceptDefault: false,
                    selected: question.kind === "single_select" ? [] : current.selected,
                    text: event.target.value,
                  }))}
                />
              )}

              {question.defaultValue !== undefined && (
                <button
                  type="button"
                  className={`structured-question__default${draft.acceptDefault ? " is-selected" : ""}`}
                  onClick={() => updateDraft(question.id, (current) => ({ ...current, acceptDefault: true }))}
                >
                  使用默认值：{formatDefault(question.defaultValue)}
                </button>
              )}
            </fieldset>
          );
        })}
      </div>

      <div className="structured-question__actions">
        <button type="button" className="approval-action" onClick={onCancel} disabled={busy}>取消提问</button>
        <button
          type="button"
          className="approval-action approval-action--primary"
          onClick={() => onSubmit(answers)}
          disabled={!canSubmit}
        >
          {busy ? "正在恢复任务…" : "提交并继续"}
        </button>
      </div>
    </section>
  );
}
