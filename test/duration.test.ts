import { describe, expect, it } from "vitest";
import { pickUnit, toSeconds } from "../src/client/lib/duration";
describe("duration units", () => {
	it("picks the largest even unit", () => {
		expect(pickUnit(86400)).toBe(86400);
		expect(pickUnit(259200)).toBe(86400);
		expect(pickUnit(3600)).toBe(3600);
		expect(pickUnit(5400)).toBe(60);
		expect(pickUnit(90)).toBe(1);
		expect(pickUnit(0, 60)).toBe(60);
	});
	it("parses whole numbers only", () => {
		expect(toSeconds("3", 86400)).toBe(259200);
		expect(toSeconds("1.5", 60)).toBeNaN();
		expect(toSeconds("-1", 1)).toBeNaN();
		expect(toSeconds("", 1)).toBeNaN();
	});
});
