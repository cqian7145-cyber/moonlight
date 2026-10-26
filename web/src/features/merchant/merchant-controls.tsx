"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { merchantAuthClient } from "@/lib/merchant-auth-client";

export function MerchantLoginForm({ returnTo }: { returnTo: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");

  function submit(formData: FormData) {
    setMessage("");
    startTransition(async () => {
      const result = await merchantAuthClient.signIn.email({
        email: String(formData.get("email") ?? "").trim(),
        password: String(formData.get("password") ?? ""),
        rememberMe: true,
      });
      if (result.error) {
        setMessage(result.error.status === 429
          ? "尝试次数较多，请稍后再试。"
          : "登录信息不正确，或账号当前不可用。请检查后重试。");
        return;
      }
      router.replace(returnTo);
      router.refresh();
    });
  }

  return (
    <form className="merchantForm" action={submit}>
      <label htmlFor="merchant-email">邮箱</label>
      <input id="merchant-email" name="email" type="email" autoComplete="username" required maxLength={254} disabled={pending} />
      <label htmlFor="merchant-password">密码</label>
      <input id="merchant-password" name="password" type="password" autoComplete="current-password" required minLength={12} maxLength={128} disabled={pending} />
      {message ? <p className="merchantFormMessage" role="alert">{message}</p> : null}
      <button className="button buttonPrimary merchantSubmit" type="submit" disabled={pending}>
        {pending ? "正在验证…" : "登录"}
      </button>
      <p className="merchantFormHint">商家账号由 Moonlight 受控开通，不提供公开注册。</p>
    </form>
  );
}

export function MerchantLogoutButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");

  function logout() {
    setMessage("");
    startTransition(async () => {
      const result = await merchantAuthClient.signOut();
      if (result.error) {
        setMessage("暂时无法退出，请检查网络后重试。");
        return;
      }
      router.replace("/login?loggedOut=1");
      router.refresh();
    });
  }

  return (
    <div className="merchantLogout">
      <button className="merchantTextButton" type="button" onClick={logout} disabled={pending}>
        {pending ? "正在退出…" : "退出登录"}
      </button>
      {message ? <span role="alert">{message}</span> : null}
    </div>
  );
}
