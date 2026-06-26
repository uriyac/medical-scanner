import { useState } from 'react';

const ACCESS_CODE = '2090';

export default function LoginPage({ onLogin }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const [shake, setShake] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (value === ACCESS_CODE) {
      onLogin();
    } else {
      setError(true);
      setShake(true);
      setValue('');
      setTimeout(() => setShake(false), 500);
    }
  };

  return (
    <div className="login-screen">
      <div className={`login-box${shake ? ' shake' : ''}`}>
        <div className="login-logo">
          <div className="login-badge">MR</div>
        </div>

        <h1 className="login-title">MediRecord</h1>
        <p className="login-subtitle">מערכת ניהול מסמכים רפואיים</p>

        <form onSubmit={handleSubmit} className="login-form">
          <p className="login-label">סיסמת גישה</p>
          <input
            type="password"
            className={`login-input${error ? ' input-error' : ''}`}
            placeholder="• • • • • • • •"
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(false); }}
            autoFocus
          />
          {error && <p className="login-error">סיסמה שגויה, נסה שנית</p>}
          <button type="submit" className="login-btn">כניסה למערכת</button>
        </form>

        <div className="login-footer">
          גישה מוגבלת לאנשי מקצוע מורשים בלבד
        </div>
      </div>
    </div>
  );
}
