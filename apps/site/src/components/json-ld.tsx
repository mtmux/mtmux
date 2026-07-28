/**
 * Renders a JSON-LD `@graph` document.
 *
 * `<script type="application/ld+json">` is not executed, so injecting the
 * pre-serialised string is safe; we only guard `<` to avoid breaking out of
 * the script element.
 */
export function JsonLd({ json }: { json: string }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: json.replace(/</g, "\\u003c") }}
    />
  );
}
