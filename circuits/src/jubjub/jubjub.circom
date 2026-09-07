/*
    Copyright 2018 0KIMS association.

    This file is part of circom (Zero Knowledge Circuit Compiler).

    circom is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    circom is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with circom. If not, see <https://www.gnu.org/licenses/>.
*/
// Ported from: circomlib/circuits/babyjub.circom (circomlib v2.0.5, vendored
// in circuits/node_modules/circomlib).
// Changes from the original:
//   - a, d replaced with Jubjub's curve constants (see circuits/scripts/jubjub-ref.mjs).
//   - BabyAdd, BabyDbl, BabyCheck renamed to JubjubAdd, JubjubDbl, JubjubCheck.
//   - BabyPbk dropped entirely (not ported), so the bitify.circom and
//     escalarmulfix.circom includes it needed are dropped too.
// Only valid when compiled with `circom -p bls12381`.
pragma circom 2.0.0;

template JubjubAdd() {
    signal input x1;
    signal input y1;
    signal input x2;
    signal input y2;
    signal output xout;
    signal output yout;

    signal beta;
    signal gamma;
    signal delta;
    signal tau;

    var a = 52435875175126190479447740508185965837690552500527637822603658699938581184512;
    var d = 19257038036680949359750312669786877991949435402254120286184196891950884077233;

    beta <== x1*y2;
    gamma <== y1*x2;
    delta <== (-a*x1+y1)*(x2 + y2);
    tau <== beta * gamma;

    xout <-- (beta + gamma) / (1+ d*tau);
    (1+ d*tau) * xout === (beta + gamma);

    yout <-- (delta + a*beta - gamma) / (1-d*tau);
    (1-d*tau)*yout === (delta + a*beta - gamma);
}

template JubjubDbl() {
    signal input x;
    signal input y;
    signal output xout;
    signal output yout;

    component adder = JubjubAdd();
    adder.x1 <== x;
    adder.y1 <== y;
    adder.x2 <== x;
    adder.y2 <== y;

    adder.xout ==> xout;
    adder.yout ==> yout;
}


template JubjubCheck() {
    signal input x;
    signal input y;

    signal x2;
    signal y2;

    var a = 52435875175126190479447740508185965837690552500527637822603658699938581184512;
    var d = 19257038036680949359750312669786877991949435402254120286184196891950884077233;

    x2 <== x*x;
    y2 <== y*y;

    a*x2 + y2 === 1 + d*x2*y2;
}
