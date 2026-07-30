import { redirect } from "next/navigation";

/**
 * An old link. Sending it to `/login` was wrong twice over: that page asks for
 * a self-hosted relay token, which is not a registration, and someone who
 * followed a link labelled "register" wants an account. `/signup` is that.
 */
export default function RegisterPage() {
  redirect("/signup");
}
