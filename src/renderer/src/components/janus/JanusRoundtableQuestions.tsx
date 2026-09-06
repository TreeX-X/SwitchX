import { useI18n } from '@/i18n/useI18n'

export interface RoundtableQuestionItem {
  id: string
  text: string
  updatedAt: string
}

interface JanusRoundtableQuestionsProps {
  roundNumber: number
  open: RoundtableQuestionItem[]
  answered: RoundtableQuestionItem[]
}

/**
 * §37.10: member questions detail island. Shares the agent-result detail
 * visual language (same canvas, eyebrow, sections); the discussion stream
 * stays flow-only while full question texts live here.
 */
export function JanusRoundtableQuestions({ roundNumber, open, answered }: JanusRoundtableQuestionsProps) {
  const { t } = useI18n('janus')
  return (
    <div className="janus-agent-result-detail janus-roundtable-questions" data-detailed="true">
      <div className="janus-agent-result-detail__eyebrow">
        {t('janus:roundtable.questions.eyebrow')} // {t('janus:roundtable.questions.open')} {open.length} · R{roundNumber}
      </div>
      <h2>{t('janus:roundtable.auxiliary.questionsTitle')}</h2>
      {open.length === 0 ? <p className="janus-agent-result-detail__summary">{t('janus:roundtable.questions.empty')}</p> : null}
      {open.map((item, index) => (
        <section key={item.id}>
          <h3>Q{index + 1} · {t('janus:roundtable.questions.open')}</h3>
          <p>{item.text}</p>
          <small>{t('janus:roundtable.questions.updated', { time: new Date(item.updatedAt).toLocaleString() })}</small>
        </section>
      ))}
      <section>
        <h3>{t('janus:roundtable.questions.answered')} ({answered.length})</h3>
        {answered.length === 0
          ? <p>{t('janus:roundtable.questions.answeredEmpty')}</p>
          : answered.map((item) => <p key={item.id}>{item.text}</p>)}
      </section>
    </div>
  )
}
